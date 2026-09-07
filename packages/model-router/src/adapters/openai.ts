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
 * OpenAI adapter – supports GPT-4o, o3, o4-mini via OpenAI-compatible API.
 */
export class OpenAIAdapter extends BaseAdapter {
	readonly provider = "openai";
	readonly model: string;
	private config: Config;

	constructor(model: string, config: Config = {}) {
		super();
		this.model = model;
		this.config = {
			baseUrl: "https://api.openai.com/v1",
			maxTokens: 4096,
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
		const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const err = await res.text();
			throw new Error(`OpenAI API error ${res.status}: ${err}`);
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
		const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const err = await res.text();
			throw new Error(`OpenAI API error ${res.status}: ${err}`);
		}

		for await (const chunk of parseSSEStream(res)) {
			if (chunk.content) yield chunk.content;
		}
	}

	private headers() {
		return {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.config.apiKey || process.env.OPENAI_API_KEY || ""}`,
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

		// OpenAI: reasoning_effort 直接映射 fast/medium/expert → low/medium/high
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
