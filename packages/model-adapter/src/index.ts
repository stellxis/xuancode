import type {
	Message,
	ModelStreamEvent,
	ToolDefinition,
} from "@xuancode/types";
import { parseSSEStream } from "./streamParser";

// ===== OpenAI 兼容工具定义格式 =====

export interface ApiToolFunction {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface ApiToolDefinition {
	type: "function";
	function: ApiToolFunction;
}

/** 从内部参数定义构建 JSON-schema 风格的 parameters 对象 */
function buildParameterSchema(def: ToolDefinition): Record<string, unknown> {
	return {
		type: "object",
		properties: Object.fromEntries(
			def.parameters.map((p) => [
				p.name,
				{
					type: p.type,
					description: p.description,
					...(p.enumValues ? { enum: p.enumValues } : {}),
				},
			]),
		),
		required: def.parameters.filter((p) => p.required).map((p) => p.name),
	};
}

/** 将内部 ToolDefinition[] 转换为 OpenAI 兼容的 tools 格式 */
export function toApiTools(definitions: ToolDefinition[]): ApiToolDefinition[] {
	return definitions.map((def) => ({
		type: "function" as const,
		function: {
			name: def.name,
			description: def.description,
			parameters: buildParameterSchema(def),
		},
	}));
}

// ===== 阵营 B · Anthropic Messages API 工具格式 =====

export interface AnthropicToolSchema {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

/** 将内部 ToolDefinition[] 转换为 Anthropic 的 tools 格式（input_schema 字段） */
export function toAnthropicTools(
	definitions: ToolDefinition[],
): AnthropicToolSchema[] {
	return definitions.map((def) => ({
		name: def.name,
		description: def.description,
		input_schema: buildParameterSchema(def),
	}));
}

// ===== 阵营 B · Gemini functionDeclarations 工具格式 =====

export interface GeminiFunctionDeclaration {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** 将内部 ToolDefinition[] 转换为 Gemini 的 functionDeclarations 格式 */
export function toGeminiTools(
	definitions: ToolDefinition[],
): GeminiFunctionDeclaration[] {
	return definitions.map((def) => ({
		name: def.name,
		description: def.description,
		parameters: buildParameterSchema(def),
	}));
}

export interface ModelAdapter {
	readonly provider: string;
	readonly modelName: string;
	chat(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): Promise<string>;
	/** 富结构流式：文本增量(string) 或 结构化工具调用事件（{type:"tool_calls"}） */
	chatStream(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): AsyncGenerator<ModelStreamEvent, void, unknown>;
}

export interface ModelAdapterConfig {
	apiKey?: string;
	baseUrl?: string;
	modelName: string;
	maxTokens?: number;
	temperature?: number;
}

// ===== DeepSeek Adapter =====

export class DeepSeekAdapter implements ModelAdapter {
	readonly provider = "deepseek";
	readonly modelName: string;
	private config: ModelAdapterConfig;

	constructor(config: ModelAdapterConfig) {
		this.config = {
			baseUrl: "https://api.deepseek.com",
			maxTokens: 4096,
			temperature: 0.3,
			...config,
		};
		this.modelName = config.modelName || "deepseek-v4-flash";
	}

	async chat(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): Promise<string> {
		const body = this.buildBody(messages, systemPrompt, false, tools);
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
		// Handle native tool_calls in non-streaming response
		const toolCalls = json.choices[0]?.message?.tool_calls;
		if (toolCalls && toolCalls.length > 0) {
			const entries = toolCalls.map((tc: any) => {
				try {
					const args = JSON.parse(tc.function.arguments || "{}");
					return JSON.stringify({ type: tc.function.name, ...args });
				} catch {
					return JSON.stringify({ type: tc.function.name });
				}
			});
			return entries.join("\n");
		}
		return json.choices[0]?.message?.content || "";
	}

	async *chatStream(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): AsyncGenerator<string, void, unknown> {
		const body = this.buildBody(messages, systemPrompt, true, tools);
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
	) {
		const msgs = [];
		if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
		msgs.push(
			...messages.map((m) => {
				const msg: Record<string, any> = { role: m.role, content: m.content };
				if (m.name) msg.name = m.name;
				if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
				return msg;
			}),
		);

		return {
			model: this.modelName,
			messages: msgs,
			stream,
			max_tokens: this.config.maxTokens,
			temperature: this.config.temperature,
			...(tools && tools.length > 0 ? { tools } : {}),
		};
	}
}

// ===== Qwen Adapter =====

export class QwenAdapter implements ModelAdapter {
	readonly provider = "qwen";
	readonly modelName: string;
	private config: ModelAdapterConfig;

	constructor(config: ModelAdapterConfig) {
		this.config = {
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
			maxTokens: 4096,
			temperature: 0.3,
			...config,
		};
		this.modelName = config.modelName || "qwen3.6-plus";
	}

	async chat(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): Promise<string> {
		const body = this.buildBody(messages, systemPrompt, false, tools);
		const res = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.config.apiKey || process.env.QWEN_API_KEY || ""}`,
			},
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const err = await res.text();
			throw new Error(`Qwen API error ${res.status}: ${err}`);
		}

		const json: any = await res.json();
		// Handle native tool_calls in non-streaming response
		const toolCalls = json.choices[0]?.message?.tool_calls;
		if (toolCalls && toolCalls.length > 0) {
			const entries = toolCalls.map((tc: any) => {
				try {
					const args = JSON.parse(tc.function.arguments || "{}");
					return JSON.stringify({ type: tc.function.name, ...args });
				} catch {
					return JSON.stringify({ type: tc.function.name });
				}
			});
			return entries.join("\n");
		}
		return json.choices[0]?.message?.content || "";
	}

	async *chatStream(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): AsyncGenerator<string, void, unknown> {
		const body = this.buildBody(messages, systemPrompt, true, tools);
		const res = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.config.apiKey || process.env.QWEN_API_KEY || ""}`,
			},
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const err = await res.text();
			throw new Error(`Qwen API error ${res.status}: ${err}`);
		}

		for await (const chunk of parseSSEStream(res)) {
			if (chunk.content) yield chunk.content;
		}
	}

	private buildBody(
		messages: Message[],
		systemPrompt?: string,
		stream?: boolean,
		tools?: ApiToolDefinition[],
	) {
		const msgs: Message[] = systemPrompt
			? [{ role: "system", content: systemPrompt }, ...messages]
			: [...messages];
		return {
			model: this.modelName,
			messages: msgs.map((m) => {
				const msg: Record<string, any> = { role: m.role, content: m.content };
				if (m.name) msg.name = m.name;
				if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
				return msg;
			}),
			stream,
			max_tokens: this.config.maxTokens,
			temperature: this.config.temperature,
			...(tools && tools.length > 0 ? { tools } : {}),
		};
	}
}

// ===== Local Mock Adapter (for testing without API) =====

export class MockAdapter implements ModelAdapter {
	readonly provider = "mock";
	readonly modelName = "mock-model";
	private callCount = 0;

	async chat(
		_messages: Message[],
		_systemPrompt?: string,
		_tools?: ApiToolDefinition[],
	): Promise<string> {
		this.callCount++;
		if (this.callCount === 1) {
			// First call: simulate a simple tool call
			return '{"type":"list_dir","path":"."}';
		}
		// Subsequent calls: respond directly (break the loop)
		return `这是一个模拟响应。已执行 ${this.callCount - 1} 个工具调用。`;
	}

	async *chatStream(
		_messages: Message[],
		_systemPrompt?: string,
		_tools?: ApiToolDefinition[],
	): AsyncGenerator<string, void, unknown> {
		this.callCount++;
		if (this.callCount === 1) {
			yield '{"type":"list_dir","path":"."}';
		} else {
			yield `这是一个模拟响应。已执行 ${this.callCount - 1} 个工具调用。`;
		}
	}
}

// ===== 缓存与重试 =====

export { ResponseCache, buildCacheKey } from "./cache";
export type { CacheConfig } from "./cache";
export { RetryAdapter } from "./retry";
export type { RetryConfig } from "./retry";
export { CachedAdapter } from "./cachedAdapter";

// ===== 流式解析 =====

export { parseSSEStream } from "./streamParser";
export type {
	StreamChunk,
	StreamResult,
	TokenUsage,
	StreamParserOptions,
} from "./streamParser";

// ===== Factory =====

export function createModelAdapter(
	provider: string,
	config: ModelAdapterConfig,
): ModelAdapter {
	switch (provider) {
		case "deepseek":
			return new DeepSeekAdapter(config);
		case "qwen":
			return new QwenAdapter(config);
		case "mock":
			return new MockAdapter();
		default:
			throw new Error(
				`不支持的模型供应商: ${provider} (支持: deepseek, qwen, mock)`,
			);
	}
}
