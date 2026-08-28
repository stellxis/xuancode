import type { Message, ModelStreamEvent } from "@xuancode/types";

/** Provider capability declaration */
export interface ProviderCapability {
	provider: string;
	modelName: string;
	contextWindow: number;
	supportsVision: boolean;
	supportsToolCalling: boolean;
	/** Cost per 1K input tokens in USD */
	costPer1KInput: number;
	/** Cost per 1K output tokens in USD */
	costPer1KOutput: number;
	/** P50 latency in milliseconds */
	latencyP50: number;
	maxOutputTokens: number;
}

/** Task profile extracted from current context */
export interface TaskProfile {
	/** Estimated number of tool calls */
	toolCallCount: number;
	/** Number of messages in context */
	contextMessages: number;
	/** Estimated total tokens */
	estimatedTokens: number;
	/** Whether input contains vision content */
	hasVisionContent: boolean;
	/** Task type classification */
	taskType: "code" | "chat" | "analysis" | "planning";
}

/** Result of model selection */
export interface SelectionResult {
	provider: string;
	modelName: string;
	capability: ProviderCapability;
	score: number;
	reason: string;
}

/** OpenAI 兼容工具定义格式 */
export interface ApiToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

/** Unified provider adapter interface */
export interface ProviderAdapter {
	readonly provider: string;
	readonly model: string;
	chat(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): Promise<string>;
	/** 富结构流式：文本增量(string) 或 结构化工具调用事件（{type:"tool_calls"}，阵营 B 通道） */
	chatStream(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): AsyncGenerator<ModelStreamEvent, void, unknown>;
}

/** Cost record for a single request */
export interface CostRecord {
	provider: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	latencyMs: number;
	timestamp: number;
}
