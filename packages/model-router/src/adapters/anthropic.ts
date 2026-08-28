import type {
	Message,
	ModelStreamEvent,
	NativeToolCall,
} from "@xuancode/types";
import type { ApiToolDefinition } from "../types";
import { BaseAdapter } from "./base";

interface Config {
	apiKey?: string;
	baseUrl?: string;
	maxTokens?: number;
	temperature?: number;
}

/** Anthropic content_block SSE 中累积中的 tool_use 块 */
interface ToolUseAcc {
	id: string;
	name: string;
	/** 显式 input（少数实现在 content_block_start 直接给全量 input） */
	explicitInput?: unknown;
	fragments: string[];
}

/**
 * Anthropic adapter – supports Claude Sonnet 4, Opus 4 via Anthropic Messages API.
 * 阵营 B-M3：原生 tool_use/tool_result content blocks + input_schema 下发 + 富结构流式。
 * 工具调用以结构化事件 {type:"tool_calls"} yield（不进 content 文本），文本仍按 token 增量流出。
 */
export class AnthropicAdapter extends BaseAdapter {
	readonly provider = "anthropic";
	readonly model: string;
	private config: Config;

	constructor(model: string, config: Config = {}) {
		super();
		this.model = model;
		this.config = {
			baseUrl: "https://api.anthropic.com/v1",
			maxTokens: 4096,
			temperature: 0.3,
			...config,
		};
	}

	/** 从非流式响应 content blocks 提取 tool_use 为 JSON 行文本（带原生 tool_use id） */
	private extractToolUseText(content: any[]): string | null {
		const uses = content?.filter((c) => c.type === "tool_use") || [];
		if (uses.length === 0) return null;
		return uses
			.map((u) => {
				const base: Record<string, any> = { type: u.name };
				if (u.id) base.id = u.id;
				const input = u.input && typeof u.input === "object" ? u.input : {};
				return JSON.stringify({ ...input, ...base });
			})
			.join("\n");
	}

	async chat(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): Promise<string> {
		const body = this.buildBody(messages, systemPrompt, false, tools);
		const res = await fetch(`${this.config.baseUrl}/messages`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const err = await res.text();
			throw new Error(`Anthropic API error ${res.status}: ${err}`);
		}

		const json: any = await res.json();
		// 优先提取原生 tool_use（与 Camp A 非流式 tool_calls 提取同构）
		const toolUses =
			json.content && Array.isArray(json.content)
				? this.extractToolUseText(json.content)
				: null;
		if (toolUses) return toolUses;
		// 回落到纯文本
		if (json.content && Array.isArray(json.content)) {
			return json.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("");
		}
		return json.content?.[0]?.text || "";
	}

	async *chatStream(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): AsyncGenerator<ModelStreamEvent, void, unknown> {
		const body = this.buildBody(messages, systemPrompt, true, tools);
		const res = await fetch(`${this.config.baseUrl}/messages`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const err = await res.text();
			throw new Error(`Anthropic API error ${res.status}: ${err}`);
		}

		// Anthropic SSE: content_block_start / content_block_delta / content_block_stop /
		// message_start / message_delta / message_stop / ping / error
		const reader = res.body?.getReader();
		if (!reader) throw new Error("No response body");

		const decoder = new TextDecoder();
		let buffer = "";
		let currentToolUse: ToolUseAcc | null = null;
		const completedToolUses: ToolUseAcc[] = [];

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

					switch (parsed.type) {
						case "error":
							throw new Error(parsed.error?.message || "Anthropic SSE error");
						case "content_block_start": {
							const block = parsed.content_block;
							if (block?.type === "tool_use") {
								currentToolUse = {
									id: block.id || "",
									name: block.name || "",
									explicitInput: block.input,
									fragments: [],
								};
							}
							break;
						}
						case "content_block_delta": {
							const delta = parsed.delta;
							if (delta?.type === "text_delta" && delta.text) {
								yield delta.text;
							} else if (delta?.type === "input_json_delta" && currentToolUse) {
								currentToolUse.fragments.push(delta.partial_json || "");
							}
							break;
						}
						case "content_block_stop": {
							if (currentToolUse) {
								completedToolUses.push(currentToolUse);
								currentToolUse = null;
							}
							break;
						}
						default:
							// message_start / message_delta / message_stop / ping 无需处理
							break;
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		// 富结构通道：工具调用以结构化事件在流尾 yield（不进 content 文本，无注入/剥离负担）
		if (completedToolUses.length > 0) {
			const toolCalls: NativeToolCall[] = completedToolUses.map((b) => {
				// input_json_delta 片段优先（真实 Anthropic 内容从这里来，content_block_start 的 input 只是空占位）
				const joined = b.fragments.join("");
				let argumentsStr: string;
				if (joined) {
					argumentsStr = joined;
				} else if (b.explicitInput !== undefined) {
					argumentsStr = JSON.stringify(b.explicitInput);
				} else {
					argumentsStr = "{}";
				}
				return { id: b.id, name: b.name, arguments: argumentsStr };
			});
			yield { type: "tool_calls", toolCalls };
		}
	}

	private headers() {
		return {
			"Content-Type": "application/json",
			"x-api-key": this.config.apiKey || process.env.ANTHROPIC_API_KEY || "",
			"anthropic-version": "2023-06-01",
		};
	}

	private buildBody(
		messages: Message[],
		systemPrompt?: string,
		stream?: boolean,
		tools?: ApiToolDefinition[],
	) {
		// Anthropic messages API expects system as top-level, not in messages array
		const msgs = messages.map((m) => BaseAdapter.buildAnthropicMessage(m));
		// ApiToolDefinition.function.parameters 已是 input_schema 形状（type/properties/required）
		const toolDefs = tools?.length
			? tools.map((t) => ({
					name: t.function.name,
					description: t.function.description,
					input_schema: t.function.parameters,
				}))
			: undefined;

		return {
			model: this.model,
			messages: msgs,
			...(systemPrompt ? { system: systemPrompt } : {}),
			...(toolDefs ? { tools: toolDefs } : {}),
			max_tokens: this.config.maxTokens,
			temperature: this.config.temperature,
			stream,
		};
	}
}
