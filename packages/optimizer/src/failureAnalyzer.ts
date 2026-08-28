/**
 * failureAnalyzer.ts — 单 Trace/Session 失败模式分析
 *
 * 复用 SpeedrunAnalyzer 的 5 种检测（excessive_reads, long_model_calls 等），
 * 新增 4 种检测（recovery_exhaustion, cost_inefficiency, context_underuse, tool_sequence_inefficiency）。
 */

import type { ErrorEntry, LogEntry, ToolCallEntry } from "@xuancode/session";
import type {
	AgentTrace,
	SpeedrunAnalyzer,
	TraceSpan,
} from "@xuancode/telemetry";
import type {
	FailurePattern,
	OptimizationSuggestion,
	PatternCategory,
	TraceAnalysisResult,
} from "./types";

/** 失败分析器 */
export class FailureAnalyzer {
	private speedrunAnalyzer: SpeedrunAnalyzer;

	constructor(speedrunAnalyzer: SpeedrunAnalyzer) {
		this.speedrunAnalyzer = speedrunAnalyzer;
	}

	/**
	 * 分析单条 Trace + 可选的 Session 日志
	 */
	analyzeTrace(trace: AgentTrace, logEntries?: LogEntry[]): FailurePattern[] {
		const patterns: FailurePattern[] = [];

		// 1. 复用 SpeedrunAnalyzer 的 5 种检测
		const speedrunResult = this.speedrunAnalyzer.analyze(trace);
		const speedrunMap: Record<
			string,
			{ severity: string; spanIds: string[]; description: string }
		> = {};
		for (const sp of speedrunResult.patterns) {
			speedrunMap[sp.type] = {
				severity: sp.severity,
				spanIds: sp.spanIds,
				description: sp.description,
			};
		}

		// 将 speedrun patterns 转为 FailurePattern
		if (speedrunMap.excessive_reads) {
			patterns.push(
				this.makePattern(
					"excessive_reads",
					speedrunMap.excessive_reads.severity as "high" | "medium" | "low",
					70,
					speedrunMap.excessive_reads.description ||
						"连续读取多个文件后没有执行写操作或模型调用",
					1,
					[trace.id],
					speedrunMap.excessive_reads.spanIds,
					"在读取文件前先思考需要什么信息，避免读取不必要的文件。读取 1-2 个文件后就应尝试生成代码或执行操作。",
					true,
					"在读取文件或搜索代码前，先明确需要什么信息。每次最多连续读取 2 个文件，之后应当尝试生成代码或执行操作。如果需要更多文件，先基于已读取的内容生成部分代码。",
				),
			);
		}

		if (speedrunMap.long_model_calls) {
			patterns.push(
				this.makePattern(
					"long_model_calls",
					speedrunMap.long_model_calls.severity as "high" | "medium" | "low",
					60,
					speedrunMap.long_model_calls.description ||
						"部分模型调用耗时超过平均值的 2 倍",
					1,
					[trace.id],
					speedrunMap.long_model_calls.spanIds,
					"考虑使用延迟更低的模型，或将复杂任务拆分为多个子任务。",
					false,
				),
			);
		}

		if (speedrunMap.frequent_compactions) {
			patterns.push(
				this.makePattern(
					"frequent_compaction",
					speedrunMap.frequent_compactions.severity as
						| "high"
						| "medium"
						| "low",
					50,
					speedrunMap.frequent_compactions.description ||
						"压缩次数超过总轮次的 50%",
					1,
					[trace.id],
					speedrunMap.frequent_compactions.spanIds,
					"减少每轮次的消息数量，控制上下文增长。考虑降低 maxTurns 限制以避免频繁压缩。",
					true,
					"注意控制单轮输出长度，避免生成过多冗余内容。优先使用精确的工具调用而非长文本回复。",
					{ maxTurns: Math.max(5, trace.turnCount - 5) },
				),
			);
		}

		if (speedrunMap.error_spikes) {
			patterns.push(
				this.makePattern(
					"error_spike",
					speedrunMap.error_spikes.severity as "high" | "medium" | "low",
					80,
					speedrunMap.error_spikes.description || "出现连续错误",
					1,
					[trace.id],
					speedrunMap.error_spikes.spanIds,
					"检查工具调用参数是否正确。在调用工具前验证文件路径、命令格式等参数。",
					true,
					"在执行工具前仔细检查参数：文件路径是否存在、命令格式是否正确、文件内容是否完整。避免在错误发生后连续重试相同操作。",
				),
			);
		}

		if (speedrunMap.tool_failures) {
			patterns.push(
				this.makePattern(
					"tool_failure_rate",
					speedrunMap.tool_failures.severity as "high" | "medium" | "low",
					75,
					speedrunMap.tool_failures.description || "工具调用失败率超过 30%",
					1,
					[trace.id],
					speedrunMap.tool_failures.spanIds,
					"提高工具调用的准确性。检查工具的使用前提条件。",
					true,
					"每次调用工具前确保：文件路径存在、命令不依赖未安装的程序、搜索模式正确。如果工具调用失败，先检查参数而非直接重试。",
				),
			);
		}

		// 2. 新增检测：recovery_exhaustion — 从 session log 中分析重试是否用尽
		if (logEntries && logEntries.length > 0) {
			const recoveryExhaustion = this.detectRecoveryExhaustion(
				logEntries,
				trace,
			);
			if (recoveryExhaustion) patterns.push(recoveryExhaustion);
		}

		// 3. 新增检测：cost_inefficiency
		const costInefficiency = this.detectCostInefficiency(trace);
		if (costInefficiency) patterns.push(costInefficiency);

		// 4. 新增检测：context_underuse
		const contextUnderuse = this.detectContextUnderuse(trace);
		if (contextUnderuse) patterns.push(contextUnderuse);

		// 5. 新增检测：tool_sequence_inefficiency
		const seqInefficiency = this.detectToolSequenceInefficiency(trace);
		if (seqInefficiency) patterns.push(seqInefficiency);

		return patterns;
	}

	/** 分析 trace 并返回完整结果 */
	analyzeFull(trace: AgentTrace, logEntries?: LogEntry[]): TraceAnalysisResult {
		const speedrunResult = this.speedrunAnalyzer.analyze(trace);
		const failurePatterns = this.analyzeTrace(trace, logEntries);

		// 计算综合评分
		const patternScores = failurePatterns.map((p) => p.score);
		const baseScore = speedrunResult.score;
		const avgPatternPenalty =
			patternScores.length > 0
				? patternScores.reduce((a, b) => a + b, 0) / patternScores.length
				: 0;
		const overallScore = Math.max(
			0,
			Math.min(100, Math.round((baseScore + (100 - avgPatternPenalty)) / 2)),
		);

		// 生成总结
		const highCount = failurePatterns.filter(
			(p) => p.severity === "high",
		).length;
		const mediumCount = failurePatterns.filter(
			(p) => p.severity === "medium",
		).length;
		let summary = "本次执行表现良好，未发现明显问题。";
		if (highCount > 0) {
			summary = `发现 ${highCount} 个严重问题和 ${mediumCount} 个中等问题，建议查看优化建议。`;
		} else if (mediumCount > 0) {
			summary = `发现 ${mediumCount} 个可改进点，整体执行效率良好。`;
		}

		const suggestion: OptimizationSuggestion = {
			id: `opt-${trace.id}-${Date.now()}`,
			timestamp: Date.now(),
			traceId: trace.id,
			patterns: failurePatterns,
			overallScore,
			summary,
		};

		return {
			trace,
			speedrunPatterns: speedrunResult.patterns,
			failurePatterns,
			suggestion,
		};
	}

	// ===== Private Detectors =====

	private detectRecoveryExhaustion(
		logEntries: LogEntry[],
		trace: AgentTrace,
	): FailurePattern | null {
		// 从 session log 的 error entries 中检测 recoverable=false 或高频率 error
		const errorEntries = logEntries.filter(
			(e): e is ErrorEntry => e.type === "error",
		);
		const nonRecoverable = errorEntries.filter((e) => !e.recoverable);

		if (nonRecoverable.length >= 2) {
			return this.makePattern(
				"recovery_exhaustion",
				"high",
				85,
				`有 ${nonRecoverable.length} 次不可恢复的错误（${nonRecoverable.map((e) => e.site).join(", ")}）`,
				nonRecoverable.length,
				[trace.id],
				[],
				"检查工具的输入参数和前置条件。不可恢复错误通常意味着工具调用方式有根本性问题。",
				true,
				"遇到错误时，先分析错误原因再决定下一步，而不是简单重试。对于权限错误，尝试替代方法。对于解析错误，检查输出格式。",
			);
		}

		// 高频错误（超过轮次一半）也是恢复耗尽信号
		if (
			errorEntries.length > 0 &&
			errorEntries.length > trace.turnCount * 0.4
		) {
			return this.makePattern(
				"recovery_exhaustion",
				"medium",
				60,
				`错误率过高：${errorEntries.length} 次错误 / ${trace.turnCount} 轮`,
				errorEntries.length,
				[trace.id],
				errorEntries.map((e) => `error-${e.turn}`),
				"减少错误发生频率，每次执行操作前验证条件是否满足。",
				true,
				"在执行每个操作前，先验证前置条件是否满足（文件是否存在、目录是否存在等）。",
			);
		}

		return null;
	}

	private detectCostInefficiency(trace: AgentTrace): FailurePattern | null {
		// 简单检测：模型调用耗时占比过高
		const modelSpans = trace.spans.filter((s) => s.kind === "model_call");
		if (modelSpans.length === 0) return null;

		const totalModelDuration = modelSpans.reduce(
			(sum, s) => sum + (s.duration ?? 0),
			0,
		);
		const traceDuration = trace.duration ?? 1;
		const modelRatio = totalModelDuration / traceDuration;

		if (modelRatio > 0.7 && trace.turnCount <= 3) {
			return this.makePattern(
				"cost_inefficiency",
				"medium",
				55,
				`模型调用占总耗时 ${(modelRatio * 100).toFixed(0)}%，但仅有 ${trace.turnCount} 轮`,
				1,
				[trace.id],
				modelSpans.map((s) => s.id),
				"考虑使用推理速度更快的模型。当前任务轮次不多，可以选择低延迟模型。",
				false,
			);
		}

		return null;
	}

	private detectContextUnderuse(trace: AgentTrace): FailurePattern | null {
		const contextUsage = trace.contextUsage ?? 0;
		if (contextUsage > 0 && contextUsage < 0.3 && trace.turnCount > 5) {
			return this.makePattern(
				"context_underuse",
				"medium",
				45,
				`上下文使用率仅 ${(contextUsage * 100).toFixed(0)}%，但执行了 ${trace.turnCount} 轮`,
				1,
				[trace.id],
				[],
				"上下文窗口未充分利用。考虑使用成本更低、上下文窗口更小的模型。",
				true,
				undefined,
				undefined, // config change: 可建议改用更便宜的模型
			);
		}
		return null;
	}

	private detectToolSequenceInefficiency(
		trace: AgentTrace,
	): FailurePattern | null {
		// 检测连续 4+ 个读取操作
		const toolSpans = trace.spans.filter((s) => s.kind === "tool_call");
		let maxConsecutiveReads = 0;
		let currentReads = 0;
		let readSpanIds: string[] = [];

		for (const span of toolSpans) {
			const name = span.name;
			if (
				name === "read_file" ||
				name === "grep" ||
				name === "glob" ||
				name === "read_directory"
			) {
				currentReads++;
				readSpanIds.push(span.id);
				maxConsecutiveReads = Math.max(maxConsecutiveReads, currentReads);
			} else {
				currentReads = 0;
				readSpanIds = [];
			}
		}

		if (maxConsecutiveReads >= 4) {
			return this.makePattern(
				"tool_sequence_inefficiency",
				"medium",
				50,
				`连续 ${maxConsecutiveReads} 次读取操作未间隔其他操作`,
				1,
				[trace.id],
				readSpanIds.slice(-maxConsecutiveReads),
				"长串的连续读取效率低下。每读取 1-2 个文件后应该暂停思考，确定下一步需要什么信息。",
				true,
				"避免连续读取超过 3 个文件而不执行其他操作。每读取一个文件后，先思考是否已有足够信息来生成代码。",
			);
		}

		return null;
	}

	private makePattern(
		category: PatternCategory,
		severity: "high" | "medium" | "low",
		score: number,
		description: string,
		occurrences: number,
		traceIds: string[],
		sampleSpanIds: string[],
		recommendation: string,
		autoFixAvailable: boolean,
		suggestedPromptFragment?: string,
		suggestedConfigChange?: Record<string, unknown>,
	): FailurePattern {
		return {
			category,
			severity,
			score,
			description,
			occurrences,
			traceIds,
			sampleSpanIds,
			recommendation,
			autoFixAvailable,
			suggestedPromptFragment,
			suggestedConfigChange,
		};
	}
}
