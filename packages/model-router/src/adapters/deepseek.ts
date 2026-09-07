import { parseSSEStream } from "@xuancode/model-adapter";
import type { Message } from "@xuancode/types";
import type { ApiToolDefinition, ReasoningLevel } from "../types";
import { BaseAdapter } from "./base";

interface Config {
	apiKey?: string;
	baseUrl?: string;
	maxTokens?: number;
	temperature?: number;
}

/**
 * DeepSeek adapter – refactored from the legacy DeepSeekAdapter.
 * Uses OpenAI-compatible API.
 */
export class DeepSeekAdapter extends BaseAdapter {
	readonly provider = "deepseek";
	readonly model: string;
	private config: Config;

	constructor(model: string, config: Config = {}) {
		super();
		this.model = model;
		this.config = {
			baseUrl: "https://api.deepseek.com",
			// 8192：推理模型思考会消耗大量输出预算，4096 常在回答/工具调用生成到一半被截断成空响应
			maxTokens: 8192,
			temperature: 0.3,
			...config,
		};
	}

	async chat(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
		reasoningLevel?: ReasoningLevel,
	): Promise<string> {
		const body = this.buildBody(
			messages,
			systemPrompt,
			false,
			tools,
			reasoningLevel,
		);
		const res = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const err = await res.text();
			throw new Error(`DeepSeek API error ${res.status}: ${err}`);
		}

		const json: any = await res.json();
		const toolCallsText = BaseAdapter.extractToolCallsText(
			json.choices?.[0]?.message,
		);
		if (toolCallsText) return toolCallsText;
		return json.choices[0]?.message?.content || "";
	}

	async *chatStream(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
		reasoningLevel?: ReasoningLevel,
	): AsyncGenerator<string, void, unknown> {
		const body = this.buildBody(
			messages,
			systemPrompt,
			true,
			tools,
			reasoningLevel,
		);
		const res = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const err = await res.text();
			throw new Error(`DeepSeek API error ${res.status}: ${err}`);
		}

		for await (const chunk of parseSSEStream(res)) {
			if (chunk.content) yield chunk.content;
		}
	}

	private headers() {
		return {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.config.apiKey || process.env.DEEPSEEK_API_KEY || ""}`,
		};
	}

	private buildBody(
		messages: Message[],
		systemPrompt?: string,
		stream?: boolean,
		tools?: ApiToolDefinition[],
		reasoningLevel?: ReasoningLevel,
	) {
		const msgs = [];
		if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
		msgs.push(...messages.map((m) => BaseAdapter.buildOpenAIMessage(m)));

		// DeepSeek: reasoning_effort 直接映射 fast/medium/expert → low/medium/high
		const reasoningEffortMap: Record<string, string> = {
			fast: "low",
			medium: "medium",
			expert: "high",
		};

		return {
			model: this.model,
			messages: msgs,
			stream,
			...(tools && tools.length > 0 ? { tools } : {}),
			max_tokens: this.config.maxTokens,
			temperature: this.config.temperature,
			...(reasoningLevel
				? { reasoning_effort: reasoningEffortMap[reasoningLevel] || "medium" }
				: {}),
		};
	}
}
