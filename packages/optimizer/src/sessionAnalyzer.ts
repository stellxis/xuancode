/**
 * sessionAnalyzer.ts — 跨 Session 趋势分析
 *
 * 聚合多条 Trace + Session 数据，生成趋势报告和工具使用统计。
 */

import type { AgentTrace, TraceSummary } from "@xuancode/telemetry";
import type {
	CrossSessionTrend,
	FailurePattern,
	PatternCategory,
	ToolUsageStats,
	TrendPoint,
	TrendReport,
} from "./types";
import type { OptimizationSuggestion } from "./types";

/** 跨 Session 分析器 */
export class SessionAnalyzer {
	/**
	 * 跨 session 趋势分析
	 */
	crossSessionTrend(
		traces: { trace: AgentTrace; patterns: FailurePattern[] }[],
		suggestions: OptimizationSuggestion[],
	): TrendReport {
		if (traces.length === 0) {
			return {
				sessionCount: 0,
				timeRange: { from: "", to: "" },
				scoreTrend: [],
				topFailures: [],
				suggestions: [],
			};
		}

		// 时间范围
		const sorted = [...traces].sort(
			(a, b) => a.trace.startTime - b.trace.startTime,
		);
		const from = new Date(sorted[0].trace.startTime)
			.toISOString()
			.split("T")[0];
		const to = new Date(sorted[sorted.length - 1].trace.startTime)
			.toISOString()
			.split("T")[0];

		// 按日期分组计算评分趋势
		const dateGroups = new Map<string, { scores: number[]; count: number }>();
		for (const { trace, patterns } of traces) {
			const date = new Date(trace.startTime).toISOString().split("T")[0];
			if (!dateGroups.has(date)) dateGroups.set(date, { scores: [], count: 0 });
			const group = dateGroups.get(date)!;
			const patternScore =
				patterns.length > 0
					? Math.max(
							0,
							100 - patterns.reduce((s, p) => s + p.score, 0) / patterns.length,
						)
					: 90;
			group.scores.push(patternScore);
			group.count++;
		}

		const scoreTrend: TrendPoint[] = Array.from(dateGroups.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([date, group]) => ({
				date,
				avgScore: Math.round(
					group.scores.reduce((a, b) => a + b, 0) / group.scores.length,
				),
				sessionCount: group.count,
			}));

		// 统计各类失败
		const categoryCounts = new Map<PatternCategory, number>();
		for (const { patterns } of traces) {
			for (const p of patterns) {
				categoryCounts.set(
					p.category,
					(categoryCounts.get(p.category) ?? 0) + 1,
				);
			}
		}

		// 计算趋势方向（比较最近一半 vs 前一半）
		const half = Math.floor(traces.length / 2);
		const recentHalf = traces.slice(half);
		const earlyHalf = traces.slice(0, half);
		const topFailures = Array.from(categoryCounts.entries())
			.sort(([, a], [, b]) => b - a)
			.slice(0, 5)
			.map(([category, count]) => {
				const recentCount = recentHalf.filter((t) =>
					t.patterns.some((p) => p.category === category),
				).length;
				const earlyCount = earlyHalf.filter((t) =>
					t.patterns.some((p) => p.category === category),
				).length;
				let trend: "up" | "down" | "stable" = "stable";
				if (earlyHalf.length > 0 && recentHalf.length > 0) {
					const recentRate = recentCount / recentHalf.length;
					const earlyRate = earlyCount / earlyHalf.length;
					if (recentRate > earlyRate * 1.2) trend = "up";
					else if (recentRate < earlyRate * 0.8) trend = "down";
				}
				return { category, count, trend };
			});

		return {
			sessionCount: traces.length,
			timeRange: { from, to },
			scoreTrend,
			topFailures,
			suggestions,
		};
	}

	/**
	 * 聚合统计
	 */
	aggregateTrend(traces: AgentTrace[]): CrossSessionTrend {
		if (traces.length === 0) {
			return {
				avgDuration: 0,
				avgTurnCount: 0,
				avgErrorCount: 0,
				avgToolCallCount: 0,
				avgContextUsage: 0,
			};
		}

		const sum = (fn: (t: AgentTrace) => number) =>
			traces.reduce((s, t) => s + fn(t), 0) / traces.length;

		return {
			avgDuration: Math.round(sum((t) => t.duration ?? 0)),
			avgTurnCount: Math.round(sum((t) => t.turnCount)),
			avgErrorCount: Math.round(sum((t) => t.errorCount) * 100) / 100,
			avgToolCallCount: Math.round(sum((t) => t.toolCallCount)),
			avgContextUsage: Math.round(sum((t) => t.contextUsage ?? 0) * 100) / 100,
		};
	}

	/**
	 * 工具使用统计
	 */
	analyzeToolUsage(traces: AgentTrace[]): ToolUsageStats[] {
		const toolMap = new Map<
			string,
			{ calls: number; failures: number; totalDuration: number }
		>();

		for (const trace of traces) {
			for (const span of trace.spans) {
				if (span.kind !== "tool_call") continue;
				const name = span.name;
				const entry = toolMap.get(name) || {
					calls: 0,
					failures: 0,
					totalDuration: 0,
				};
				entry.calls++;
				if (span.status === "error") entry.failures++;
				entry.totalDuration += span.duration ?? 0;
				toolMap.set(name, entry);
			}
		}

		return Array.from(toolMap.entries())
			.map(([toolType, stats]) => ({
				toolType,
				callCount: stats.calls,
				failureCount: stats.failures,
				failureRate: stats.calls > 0 ? stats.failures / stats.calls : 0,
				avgDuration:
					stats.calls > 0 ? Math.round(stats.totalDuration / stats.calls) : 0,
			}))
			.sort((a, b) => b.callCount - a.callCount);
	}
}
