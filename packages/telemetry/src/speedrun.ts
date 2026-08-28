/**
 * SpeedrunAnalyzer — Agent 执行效率分析
 *
 * 分析 Trace 数据，识别低效模式并给出优化建议。
 */

import type {
	AgentTrace,
	SpeedrunAnalysis,
	SpeedrunPattern,
	TraceSpan,
} from "./types.js";

export class SpeedrunAnalyzer {
	/**
	 * 分析单个 Trace 的执行效率
	 */
	analyze(trace: AgentTrace): SpeedrunAnalysis {
		const patterns: SpeedrunPattern[] = [];

		// 1. 检查过度读取模式 — 连续多个文件读取而不执行
		patterns.push(...this.detectExcessiveReads(trace));

		// 2. 检查模型调用延迟异常
		patterns.push(...this.detectLongModelCalls(trace));

		// 3. 检查频繁压缩
		patterns.push(...this.detectFrequentCompactions(trace));

		// 4. 检查错误集中爆发
		patterns.push(...this.detectErrorSpikes(trace));

		// 5. 检查工具调用失败
		patterns.push(...this.detectToolFailures(trace));

		// 计算总体评分
		const score = this.calculateScore(trace, patterns);

		// 生成优化建议
		const recommendations = this.generateRecommendations(patterns);

		return { patterns, score, recommendations };
	}

	private detectExcessiveReads(trace: AgentTrace): SpeedrunPattern[] {
		const readSpans = trace.spans.filter(
			(s) => s.kind === "tool_call" && s.name.startsWith("read_"),
		);

		if (readSpans.length < 3) return [];

		// 检查是否有连续 3+ 次读取没有中间操作
		let consecutiveReads = 0;
		let maxConsecutiveReads = 0;
		let readSpanIds: string[] = [];

		for (const span of trace.spans) {
			if (span.kind === "tool_call" && span.name.startsWith("read_")) {
				consecutiveReads++;
				if (consecutiveReads > maxConsecutiveReads) {
					maxConsecutiveReads = consecutiveReads;
					readSpanIds.push(span.id);
				}
			} else if (
				span.kind === "model_call" ||
				(span.kind === "tool_call" && !span.name.startsWith("read_"))
			) {
				if (consecutiveReads >= 3) break;
				consecutiveReads = 0;
				readSpanIds = [];
			}
		}

		if (maxConsecutiveReads >= 3) {
			return [
				{
					type: "excessive_reads",
					severity: maxConsecutiveReads >= 6 ? "high" : "medium",
					description: `连续 ${maxConsecutiveReads} 次文件读取未执行操作，建议使用 glob 通配或语义搜索减少读取次数`,
					spanIds: readSpanIds,
				},
			];
		}

		return [];
	}

	private detectLongModelCalls(trace: AgentTrace): SpeedrunPattern[] {
		const modelSpans = trace.spans.filter((s) => s.kind === "model_call");
		if (modelSpans.length === 0) return [];

		const durations = modelSpans
			.map((s) => s.duration ?? 0)
			.filter((d) => d > 0);

		if (durations.length === 0) return [];

		const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
		const outliers = modelSpans.filter((s) => (s.duration ?? 0) > avg * 2);

		if (outliers.length > 0) {
			return [
				{
					type: "long_model_calls",
					severity: outliers.length >= 3 ? "high" : "medium",
					description: `${outliers.length} 次模型调用耗时超过平均值的 2 倍（平均 ${avg.toFixed(0)}ms），可能使用了较大的 context 或模型负载高`,
					spanIds: outliers.map((s) => s.id),
				},
			];
		}

		return [];
	}

	private detectFrequentCompactions(trace: AgentTrace): SpeedrunPattern[] {
		const compactSpans = trace.spans.filter((s) => s.kind === "compression");
		if (compactSpans.length < 2) return [];

		// 如果压缩超过轮次的一半，过于频繁
		const turnCount = trace.turnCount || 1;
		if (compactSpans.length > turnCount * 0.5) {
			return [
				{
					type: "frequent_compactions",
					severity: "medium",
					description: `压缩发生 ${compactSpans.length} 次（${turnCount} 轮中），过于频繁。考虑增大 compactThreshold 或减小 maxTurns`,
					spanIds: compactSpans.map((s) => s.id),
				},
			];
		}

		return [];
	}

	private detectErrorSpikes(trace: AgentTrace): SpeedrunPattern[] {
		const errorSpans = trace.spans.filter((s) => s.status === "error");
		if (errorSpans.length < 2) return [];

		// 检查是否连续出错
		let consecutiveErrors = 0;
		let maxConsecutive = 0;
		const errorSpanIds: string[] = [];

		for (const span of trace.spans) {
			if (span.status === "error") {
				consecutiveErrors++;
				if (consecutiveErrors > maxConsecutive) {
					maxConsecutive = consecutiveErrors;
					errorSpanIds.push(span.id);
				}
			} else {
				consecutiveErrors = 0;
			}
		}

		if (maxConsecutive >= 2) {
			return [
				{
					type: "error_spikes",
					severity: maxConsecutive >= 4 ? "high" : "medium",
					description: `连续 ${maxConsecutive} 次操作出错，可能存在系统性故障`,
					spanIds: errorSpanIds,
				},
			];
		}

		return [];
	}

	private detectToolFailures(trace: AgentTrace): SpeedrunPattern[] {
		const failedTools = trace.spans.filter(
			(s) => s.kind === "tool_call" && s.status === "error",
		);

		if (failedTools.length === 0) return [];
		const totalTools = trace.spans.filter((s) => s.kind === "tool_call").length;
		const failureRate = failedTools.length / totalTools;

		if (failureRate > 0.3) {
			return [
				{
					type: "tool_failures",
					severity: failureRate > 0.5 ? "high" : "medium",
					description: `工具调用失败率 ${(failureRate * 100).toFixed(0)}%（${failedTools.length}/${totalTools}），高于 30% 阈值`,
					spanIds: failedTools.map((s) => s.id),
				},
			];
		}

		return [];
	}

	private calculateScore(
		trace: AgentTrace,
		patterns: SpeedrunPattern[],
	): number {
		let score = 100;

		// 扣分：每个高严重度模式扣 20 分，中扣 10 分，低扣 5 分
		for (const p of patterns) {
			if (p.severity === "high") score -= 20;
			else if (p.severity === "medium") score -= 10;
			else score -= 5;
		}

		// 扣分：错误次数过多
		if (trace.errorCount > 5) score -= 10;
		if (trace.errorCount > 10) score -= 10;

		// 加分：低错误率
		if (trace.errorCount === 0) score += 5;
		if (trace.toolCallCount > 0 && trace.errorCount / trace.toolCallCount < 0.1)
			score += 5;

		return Math.max(0, Math.min(100, score));
	}

	private generateRecommendations(patterns: SpeedrunPattern[]): string[] {
		const recommendations: string[] = [];
		const seen = new Set<string>();

		for (const p of patterns) {
			switch (p.type) {
				case "excessive_reads":
					if (!seen.has("read")) {
						recommendations.push(
							"考虑使用 glob 通配模式一次性匹配多个文件，或使用语义搜索替代顺序读取",
						);
						seen.add("read");
					}
					break;
				case "long_model_calls":
					if (!seen.has("model")) {
						recommendations.push(
							"部分模型调用耗时异常，可考虑切换低延迟模型，或减少单次 context 大小",
						);
						seen.add("model");
					}
					break;
				case "frequent_compactions":
					if (!seen.has("compact")) {
						recommendations.push(
							"压缩次数过多，可增大 compactThreshold（当前 0.7）或限制 maxTurns",
						);
						seen.add("compact");
					}
					break;
				case "error_spikes":
					if (!seen.has("error")) {
						recommendations.push(
							"连续错误提示可能环境配置有问题，检查 API Key 和工作目录权限",
						);
						seen.add("error");
					}
					break;
				case "tool_failures":
					if (!seen.has("fail")) {
						recommendations.push(
							"工具调用失败率高，检查文件路径有效性和命令兼容性",
						);
						seen.add("fail");
					}
					break;
			}
		}

		if (recommendations.length === 0) {
			recommendations.push("执行效率良好，未发现明显低效模式");
		}

		return recommendations;
	}
}
