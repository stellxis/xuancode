/**
 * @xuancode/telemetry — 可观测性数据模型
 *
 * Span 是基本追踪单元，一个 Trace 由多个 Span 组成 DAG。
 * 每个 Span 带有五行元素标签用于 UI 颜色编码。
 */

/** 五行元素标签 */
export type FiveElement =
	| "metal"
	| "wood"
	| "water"
	| "fire"
	| "earth"
	| "none";

/** Span 状态 */
export type SpanStatus = "ok" | "error" | "warning";

/** Span 类型 */
export type SpanKind =
	| "turn"
	| "model_call"
	| "tool_call"
	| "compression"
	| "memory"
	| "hook"
	| "mcp_call"
	| "a2a_call";

/** 单个追踪 Span */
export interface TraceSpan {
	/** 全局唯一 ID */
	id: string;
	/** 所属 Trace ID */
	traceId: string;
	/** 父 Span ID（null = root span） */
	parentId: string | null;
	/** Span 名称（如 "turn-3", "model-call", "read_file"） */
	name: string;
	/** Span 类型 */
	kind: SpanKind;
	/** 五行元素标签 */
	element: FiveElement;
	/** 开始时间戳（毫秒） */
	startTime: number;
	/** 结束时间戳（毫秒），null = 进行中 */
	endTime: number | null;
	/** 耗时（毫秒） */
	duration: number | null;
	/** 状态 */
	status: SpanStatus;
	/** 关联的元数据 */
	attributes: Record<string, unknown>;
	/** 错误信息 */
	error?: string;
}

/** 完整的 Trace 记录 */
export interface AgentTrace {
	id: string;
	/** 关联的任务 ID */
	taskId?: string;
	/** 用户输入 */
	input: string;
	/** 开始时间 */
	startTime: number;
	/** 结束时间 */
	endTime: number | null;
	/** 总耗时 */
	duration: number | null;
	/** 所有 Span */
	spans: TraceSpan[];
	/** 轮次数量 */
	turnCount: number;
	/** 工具调用次数 */
	toolCallCount: number;
	/** 错误次数 */
	errorCount: number;
	/** 最终停止原因 */
	stopReason?: string;
	/** 上下文使用率 */
	contextUsage?: number;
}

/** Trace 汇总统计 */
export interface TraceSummary {
	id: string;
	taskId?: string;
	input: string;
	startTime: number;
	duration: number | null;
	turnCount: number;
	toolCallCount: number;
	errorCount: number;
	stopReason?: string;
}

/** Telemetry 配置 */
export interface TelemetryOptions {
	/** 最大 span 数量（默认 500） */
	maxSpans?: number;
	/** 最大 trace 数量（默认 50） */
	maxTraces?: number;
	/** 是否启用详细追踪 */
	verbose?: boolean;
	/** trace 落盘目录（jsonl 按天分文件）；不设则纯内存 */
	sinkDir?: string;
}

/** OTLP 导出配置（预留） */
export interface OTLPExporterOptions {
	endpoint: string;
	headers?: Record<string, string>;
}

/** Speedrun 分析结果 */
export interface SpeedrunAnalysis {
	/** 发现的低效模式列表 */
	patterns: SpeedrunPattern[];
	/** 总体评分（0-100，越高越好） */
	score: number;
	/** 优化建议 */
	recommendations: string[];
}

export interface SpeedrunPattern {
	type:
		| "excessive_reads"
		| "long_model_calls"
		| "frequent_compactions"
		| "error_spikes"
		| "tool_failures";
	severity: "low" | "medium" | "high";
	description: string;
	spanIds: string[];
}
