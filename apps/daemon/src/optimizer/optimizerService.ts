/**
 * OptimizerService — Daemon 端优化器服务
 *
 * 封装 @xuancode/optimizer 的三个核心组件，通过 Tracer 和 SessionManager
 * 提供对已完成 trace 的分析、跨 session 趋势汇总和优化建议列表。
 */

import {
	FailureAnalyzer,
	PromptOptimizer,
	SessionAnalyzer,
} from "@xuancode/optimizer";
import type {
	FailurePattern,
	OptimizationSuggestion,
	ToolUsageStats,
	TrendReport,
} from "@xuancode/optimizer";
import type { SessionManager } from "@xuancode/session";
import type { SpeedrunAnalyzer, Tracer } from "@xuancode/telemetry";

export interface FeedbackRecord {
	suggestionId: string;
	action: "applied_config" | "copied_prompt" | "dismissed";
	timestamp: number;
}

export class OptimizerService {
	private failureAnalyzer: FailureAnalyzer;
	private sessionAnalyzer: SessionAnalyzer;
	private promptOptimizer: PromptOptimizer;
	private suggestions: OptimizationSuggestion[] = [];
	private feedbackLog: FeedbackRecord[] = [];

	constructor(
		private tracer: Tracer,
		speedrunAnalyzer: SpeedrunAnalyzer,
		private sessionManager: SessionManager,
	) {
		this.failureAnalyzer = new FailureAnalyzer(speedrunAnalyzer);
		this.sessionAnalyzer = new SessionAnalyzer();
		this.promptOptimizer = new PromptOptimizer();
	}

	/** 分析单条 trace */
	async analyzeTrace(traceId: string): Promise<OptimizationSuggestion> {
		const trace = this.tracer.getTrace(traceId);
		if (!trace) throw new Error(`Trace not found: ${traceId}`);

		// 尝试加载 session 日志
		let logEntries: any[] | undefined;
		try {
			const sessions = await this.sessionManager.listSessions();
			const matching = sessions.find(
				(s) => s.sessionId === trace.taskId || s.sessionId === traceId,
			);
			if (matching) {
				const store = await this.sessionManager.loadSession(matching.sessionId);
				logEntries = (await store.readAll()) as any[];
			}
		} catch {
			/* session log not available — proceed without */
		}

		const result = this.failureAnalyzer.analyzeFull(trace, logEntries);

		// 缓存建议
		this.suggestions.unshift(result.suggestion);
		if (this.suggestions.length > 100)
			this.suggestions = this.suggestions.slice(0, 100);

		return result.suggestion;
	}

	/** 跨 session 趋势分析 */
	async analyzeTrends(limit = 20): Promise<TrendReport> {
		const traces = this.tracer.listTraces(limit);
		const analyzed: { trace: any; patterns: FailurePattern[] }[] = [];

		for (const summary of traces) {
			const trace = this.tracer.getTrace(summary.id);
			if (!trace) continue;
			const patterns = this.failureAnalyzer.analyzeTrace(trace);
			analyzed.push({ trace, patterns });
		}

		return this.sessionAnalyzer.crossSessionTrend(analyzed, this.suggestions);
	}

	/** 列出所有建议 */
	async listSuggestions(limit = 20): Promise<OptimizationSuggestion[]> {
		// 如果有缓存的建议，直接返回
		if (this.suggestions.length > 0) {
			return this.suggestions.slice(0, limit);
		}

		// 否则分析最近的 trace
		const traces = this.tracer.listTraces(limit);
		const suggestions: OptimizationSuggestion[] = [];

		for (const summary of traces) {
			const trace = this.tracer.getTrace(summary.id);
			if (!trace) continue;
			const patterns = this.failureAnalyzer.analyzeTrace(trace);
			const score =
				patterns.length > 0
					? Math.max(
							0,
							100 - patterns.reduce((s, p) => s + p.score, 0) / patterns.length,
						)
					: 90;
			suggestions.push({
				id: `opt-${trace.id}-${Date.now()}`,
				timestamp: Date.now(),
				traceId: trace.id,
				patterns,
				overallScore: Math.round(score),
				summary: this.promptOptimizer.composeSummary(patterns),
			});
		}

		this.suggestions = suggestions;
		return suggestions;
	}

	/** 记录用户对建议的反馈 */
	recordFeedback(suggestionId: string, action: FeedbackRecord["action"]): void {
		this.feedbackLog.push({ suggestionId, action, timestamp: Date.now() });
		if (this.feedbackLog.length > 500) {
			this.feedbackLog = this.feedbackLog.slice(-500);
		}
	}

	/** 获取反馈统计 */
	getFeedbackStats(): {
		total: number;
		applied: number;
		copied: number;
		dismissed: number;
	} {
		const applied = this.feedbackLog.filter(
			(f) => f.action === "applied_config",
		).length;
		const copied = this.feedbackLog.filter(
			(f) => f.action === "copied_prompt",
		).length;
		const dismissed = this.feedbackLog.filter(
			(f) => f.action === "dismissed",
		).length;
		return { total: this.feedbackLog.length, applied, copied, dismissed };
	}

	/** 获取工具使用统计 */
	async getToolUsageStats(limit = 50): Promise<ToolUsageStats[]> {
		const traces = this.tracer.listTraces(limit);
		const fullTraces = traces
			.map((s) => this.tracer.getTrace(s.id))
			.filter((t): t is NonNullable<typeof t> => t !== null);

		return this.sessionAnalyzer.analyzeToolUsage(fullTraces);
	}
}
