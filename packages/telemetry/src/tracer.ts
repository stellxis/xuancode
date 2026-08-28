/**
 * Tracer — Span 创建与 Trace 管理
 *
 * 零外部依赖，通过 EventEmitter 广播 span 事件。
 * 如果无人监听，事件立即被 GC，零开销。
 */

import { EventEmitter } from "node:events";
import type {
	AgentTrace,
	FiveElement,
	SpanKind,
	SpanStatus,
	TelemetryOptions,
	TraceSpan,
	TraceSummary,
} from "./types.js";

let spanCounter = 0;
function nextId(): string {
	spanCounter++;
	return `span-${Date.now()}-${spanCounter}`;
}

function traceId(): string {
	return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class Tracer {
	private traces = new Map<string, AgentTrace>();
	private activeTrace: AgentTrace | null = null;
	private emitter = new EventEmitter();
	private options: Required<TelemetryOptions>;

	constructor(options: TelemetryOptions = {}) {
		this.options = {
			maxSpans: 500,
			maxTraces: 50,
			verbose: false,
			...options,
		};
	}

	/** 创建一个新的 Trace */
	startTrace(input: string, taskId?: string): AgentTrace {
		// 清理旧 trace
		this.evictOldTraces();

		const tr: AgentTrace = {
			id: traceId(),
			taskId,
			input: input.slice(0, 200),
			startTime: performance.now(),
			endTime: null,
			duration: null,
			spans: [],
			turnCount: 0,
			toolCallCount: 0,
			errorCount: 0,
		};

		this.traces.set(tr.id, tr);
		this.activeTrace = tr;
		this.emitter.emit("trace_start", tr);
		return tr;
	}

	/** 结束当前 Trace */
	endTrace(updates?: Partial<AgentTrace>): AgentTrace | null {
		if (!this.activeTrace) return null;
		this.activeTrace.endTime = performance.now();
		this.activeTrace.duration =
			this.activeTrace.endTime - this.activeTrace.startTime;
		if (updates) Object.assign(this.activeTrace, updates);
		this.emitter.emit("trace_end", this.activeTrace);
		const tr = this.activeTrace;
		this.activeTrace = null;
		return tr;
	}

	/** 获取当前活跃 Trace */
	getActiveTrace(): AgentTrace | null {
		return this.activeTrace;
	}

	/** 创建一个 Span 并添加到当前活跃 Trace */
	startSpan(
		name: string,
		kind: SpanKind,
		element: FiveElement = "none",
		parentId: string | null = null,
	): TraceSpan | null {
		if (!this.activeTrace) return null;
		if (this.activeTrace.spans.length >= this.options.maxSpans) return null;

		const span: TraceSpan = {
			id: nextId(),
			traceId: this.activeTrace.id,
			parentId,
			name,
			kind,
			element,
			startTime: performance.now(),
			endTime: null,
			duration: null,
			status: "ok",
			attributes: {},
		};

		this.activeTrace.spans.push(span);
		this.emitter.emit("span_start", span);
		return span;
	}

	/** 结束一个 Span */
	endSpan(
		spanId: string,
		status: SpanStatus = "ok",
		attributes?: Record<string, unknown>,
	): void {
		if (!this.activeTrace) return;
		const span = this.activeTrace.spans.find((s) => s.id === spanId);
		if (!span) return;

		span.endTime = performance.now();
		span.duration = span.endTime - span.startTime;
		span.status = status;
		if (attributes) Object.assign(span.attributes, attributes);
		if (status === "error") {
			this.activeTrace.errorCount++;
		}
		this.emitter.emit("span_end", span);
	}

	/** 标记一个 Span 为错误 */
	setSpanError(spanId: string, error: string): void {
		const span = this.activeTrace?.spans.find((s) => s.id === spanId);
		if (span) {
			span.status = "error";
			span.error = error;
		}
	}

	/** 向 Span 添加属性 */
	setSpanAttributes(spanId: string, attributes: Record<string, unknown>): void {
		const span = this.activeTrace?.spans.find((s) => s.id === spanId);
		if (span) {
			Object.assign(span.attributes, attributes);
		}
	}

	/** 增加 trace 级别计数器 */
	incrementTurn(): void {
		if (this.activeTrace) this.activeTrace.turnCount++;
	}

	incrementToolCall(): void {
		if (this.activeTrace) this.activeTrace.toolCallCount++;
	}

	/** 获取指定 Trace */
	getTrace(id: string): AgentTrace | undefined {
		return this.traces.get(id);
	}

	/** 导入外部 Trace（例如从 Worker 进程重建） */
	importTrace(trace: AgentTrace): void {
		if (this.traces.has(trace.id)) return;
		this.evictOldTraces();
		this.traces.set(trace.id, trace);
		this.emitter.emit("trace_imported", trace);
	}

	/** 获取所有 Trace 摘要 */
	listTraces(limit = 20): TraceSummary[] {
		return Array.from(this.traces.values())
			.sort((a, b) => b.startTime - a.startTime)
			.slice(0, limit)
			.map((t) => ({
				id: t.id,
				taskId: t.taskId,
				input: t.input,
				startTime: t.startTime,
				duration: t.duration,
				turnCount: t.turnCount,
				toolCallCount: t.toolCallCount,
				errorCount: t.errorCount,
				stopReason: t.stopReason,
			}));
	}

	/** 获取当前 trace 的所有 spans（用于实时推送） */
	getCurrentSpans(): TraceSpan[] {
		return this.activeTrace?.spans ?? [];
	}

	/** 订阅 span 事件 */
	onSpanEvent(
		event: "span_start" | "span_end",
		listener: (span: TraceSpan) => void,
	): () => void {
		this.emitter.on(event, listener);
		return () => {
			this.emitter.off(event, listener);
		};
	}

	/** 订阅 trace 事件 */
	onTraceEvent(
		event: "trace_start" | "trace_end",
		listener: (trace: AgentTrace) => void,
	): () => void {
		this.emitter.on(event, listener);
		return () => {
			this.emitter.off(event, listener);
		};
	}

	/** 清理过期 traces */
	private evictOldTraces(): void {
		if (this.traces.size >= this.options.maxTraces) {
			const sorted = Array.from(this.traces.entries()).sort(
				([, a], [, b]) => a.startTime - b.startTime,
			);
			const toDelete = sorted.slice(
				0,
				this.traces.size - this.options.maxTraces + 1,
			);
			for (const [id] of toDelete) {
				this.traces.delete(id);
			}
		}
	}

	/** 获取 Traces 数量 */
	get traceCount(): number {
		return this.traces.size;
	}

	/** 重置所有数据 */
	reset(): void {
		this.traces.clear();
		this.activeTrace = null;
		this.emitter.removeAllListeners();
	}
}
