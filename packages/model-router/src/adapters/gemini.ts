import type {
	Message,
	ModelStreamEvent,
	NativeToolCall,
} from "@xuancode/types";
import type { ApiToolDefinition, ReasoningLevel } from "../types";
import { BaseAdapter } from "./base";

interface Config {
	apiKey?: string;
	baseUrl?: string;
	maxTokens?: number;
	temperature?: number;
}

/** Gemini 流式 functionCall 累积器（分双形态） */
interface FunctionCallAcc {
	name: string;
	/** 1.x 形态：args 是跨 chunk 的 JSON 字符串片段 → 串接后交给下游 JSON.parse */
	argsText: string;
	/** 2.x 形态：args 是逐 chunk 更完整的部分对象快照 → 深合并（后 chunk 覆盖先 chunk） */
	argsObj?: Record<string, any>;
	hasObject: boolean;
}

/** 简单深合并：数组整体覆盖，普通对象递归合并，其余后者覆盖 */
function deepMerge(a: any, b: any): any {
	if (Array.isArray(a) || Array.isArray(b)) return b;
	if (
		a !== null &&
		typeof a === "object" &&
		b !== null &&
		typeof b === "object"
	) {
		const out: Record<string, any> = { ...a };
		for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
		return out;
	}
	return b;
}

/**
 * Google Gemini adapter – supports Gemini 2.5 Pro/Flash via REST API.
 * 阵营 B-M4：functionCall/functionResponse parts + functionDeclarations 下发 + 流式 JSON 参数拼接。
 * 工具调用以结构化事件 {type:"tool_calls"} yield（不进 content 文本），文本仍按 chunk 增量流出。
 * Gemini 协议无原生 tool id → 合成 id "name::index"（供回灌还原函数名 + taorLoop 去重）。
 */
export class GeminiAdapter extends BaseAdapter {
	readonly provider = "google";
	readonly model: string;
	private config: Config;

	constructor(model: string, config: Config = {}) {
		super();
		this.model = model;
		this.config = {
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			maxTokens: 4096,
			temperature: 0.3,
			...config,
		};
	}

	/** 从非流式响应 parts 提取 functionCall 为 JSON 行文本（合成 id "name::index"） */
	private extractFunctionCallsText(parts: any[]): string | null {
		const calls = parts?.filter((p: any) => p.functionCall) || [];
		if (calls.length === 0) return null;
		return calls
			.map((p: any, i: number) => {
				const fc = p.functionCall;
				const base: Record<string, any> = { type: fc.name };
				base.id = `${fc.name}::${i}`;
				let args: Record<string, any> = {};
				try {
					const raw =
						typeof fc.args === "string" ? JSON.parse(fc.args) : fc.args;
					args = raw && typeof raw === "object" ? raw : {};
				} catch {
					args = {};
				}
				return JSON.stringify({ ...args, ...base });
			})
			.join("\n");
	}

	async chat(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
		reasoningLevel?: ReasoningLevel,
	): Promise<string> {
		const body = this.buildBody(messages, systemPrompt, tools, reasoningLevel);
		const url = `${this.config.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey()}`;
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const err = await res.text();
			throw new Error(`Gemini API error ${res.status}: ${err}`);
		}

		const json: any = await res.json();
		// 优先提取原生 functionCall（与 Camp A 非流式 tool_calls 提取同构）
		const parts = json.candidates?.[0]?.content?.parts;
		const fnCalls = this.extractFunctionCallsText(parts);
		if (fnCalls) return fnCalls;
		// 回落到纯文本
		return (
			parts
				?.filter((p: any) => p.text)
				.map((p: any) => p.text)
				.join("") || ""
		);
	}

	async *chatStream(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
		reasoningLevel?: ReasoningLevel,
	): AsyncGenerator<ModelStreamEvent, void, unknown> {
		const body = this.buildBody(messages, systemPrompt, tools, reasoningLevel);
		const url = `${this.config.baseUrl}/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey()}`;
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const err = await res.text();
			throw new Error(`Gemini API error ${res.status}: ${err}`);
		}

		const reader = res.body?.getReader();
		if (!reader) throw new Error("No response body");

		const decoder = new TextDecoder();
		let buffer = "";
		const fnCalls: FunctionCallAcc[] = [];

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					const data = line.slice(6).trim();
					if (!data || data === "[DONE]") continue;

					let parsed: any;
					try {
						parsed = JSON.parse(data);
					} catch {
						continue; // 跳过不可解析块
					}

					const parts = parsed.candidates?.[0]?.content?.parts;
					if (!parts || !Array.isArray(parts)) continue;

					// 每 chunk 内同一下标至多合并一次 → 同 chunk 内同名两次视为两个独立调用
					const mergedThisChunk = new Set<number>();
					for (const part of parts) {
						if (part.text) {
							yield part.text;
							continue;
						}
						const fc = part.functionCall;
						if (!fc || !fc.name) continue;

						const idx = fnCalls.length - 1;
						if (
							idx >= 0 &&
							fnCalls[idx].name === fc.name &&
							!mergedThisChunk.has(idx)
						) {
							mergedThisChunk.add(idx);
						} else {
							fnCalls.push({ name: fc.name, argsText: "", hasObject: false });
							mergedThisChunk.add(fnCalls.length - 1);
						}
						const acc = fnCalls[fnCalls.length - 1];
						if (typeof fc.args === "string") {
							acc.argsText += fc.args;
						} else if (fc.args && typeof fc.args === "object") {
							acc.argsObj = acc.argsObj
								? deepMerge(acc.argsObj, fc.args)
								: { ...fc.args };
							acc.hasObject = true;
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		// 富结构通道：工具调用以结构化事件在流尾 yield（不进 content 文本，无注入/剥离负担）
		if (fnCalls.length > 0) {
			const toolCalls: NativeToolCall[] = fnCalls.map((acc, i) => {
				let argumentsStr: string;
				if (acc.hasObject) {
					argumentsStr = JSON.stringify(acc.argsObj);
				} else if (acc.argsText) {
					argumentsStr = acc.argsText;
				} else {
					argumentsStr = "{}";
				}
				return {
					id: `${acc.name}::${i}`,
					name: acc.name,
					arguments: argumentsStr,
				};
			});
			yield { type: "tool_calls", toolCalls };
		}
	}

	private apiKey(): string {
		return this.config.apiKey || process.env.GOOGLE_API_KEY || "";
	}

	private buildBody(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
		reasoningLevel?: ReasoningLevel,
	) {
		const contents = messages.map((m) => BaseAdapter.buildGeminiMessage(m));
		// ApiToolDefinition.function.parameters 已是 JSON-Schema 形状 → 直接作 functionDeclarations.parameters
		const functionDeclarations = tools?.length
			? tools.map((t) => ({
					name: t.function.name,
					description: t.function.description,
					parameters: t.function.parameters,
				}))
			: undefined;

		// Gemini: thinkingConfig.thinkingBudget 映射 fast/medium/expert → 0/8192/32768
		const thinkingBudgetMap: Record<string, number> = {
			fast: 0,
			medium: 8192,
			expert: 32768,
		};

		return {
			contents,
			...(systemPrompt
				? { systemInstruction: { parts: [{ text: systemPrompt }] } }
				: {}),
			...(functionDeclarations ? { tools: [{ functionDeclarations }] } : {}),
			generationConfig: {
				maxOutputTokens: this.config.maxTokens,
				temperature: this.config.temperature,
				...(reasoningLevel
					? {
							thinkingConfig: {
								thinkingBudget: thinkingBudgetMap[reasoningLevel] ?? 8192,
							},
						}
					: {}),
			},
		};
	}
}
