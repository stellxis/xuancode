/**
 * promptOptimizer.ts — System Prompt 优化片段生成
 *
 * 根据 FailurePattern 生成中文优化建议文本和 System Prompt 片段。
 * 所有输出**仅供查看**，默认不自动注入。
 */

import type {
	FailurePattern,
	OptimizationSuggestion,
	PatternCategory,
} from "./types";

/** 优化建议生成器 */
export class PromptOptimizer {
	/**
	 * 根据 FailurePattern 生成可读的优化建议文本
	 */
	generateRecommendations(patterns: FailurePattern[]): string {
		if (patterns.length === 0) return "✓ 未发现优化建议，当前执行配置良好。";

		const lines: string[] = ["## 自改进分析结果\n"];
		const high = patterns.filter((p) => p.severity === "high");
		const medium = patterns.filter((p) => p.severity === "medium");
		const low = patterns.filter((p) => p.severity === "low");

		if (high.length > 0) {
			lines.push("### 严重问题\n");
			for (const p of high) {
				lines.push(`- **${this.categoryLabel(p.category)}**: ${p.description}`);
				lines.push(`  - 建议: ${p.recommendation}`);
				if (p.suggestedPromptFragment) {
					lines.push(`  - 可参考提示词: \`${p.suggestedPromptFragment}\``);
				}
				lines.push("");
			}
		}

		if (medium.length > 0) {
			lines.push("### 可改进项\n");
			for (const p of medium) {
				lines.push(`- **${this.categoryLabel(p.category)}**: ${p.description}`);
				lines.push(`  - 建议: ${p.recommendation}`);
				lines.push("");
			}
		}

		if (low.length > 0) {
			lines.push("### 轻微提示\n");
			for (const p of low) {
				lines.push(`- ${this.categoryLabel(p.category)}: ${p.recommendation}`);
			}
			lines.push("");
		}

		return lines.join("\n");
	}

	/**
	 * 生成 System Prompt 优化片段
	 */
	generatePromptFragments(patterns: FailurePattern[]): string {
		const fragments = patterns
			.filter((p) => p.autoFixAvailable && p.suggestedPromptFragment)
			.map((p) => p.suggestedPromptFragment!);

		if (fragments.length === 0) return "";

		const unique = [...new Set(fragments)];
		return unique.join(" ");
	}

	/**
	 * 为前端展示生成摘要
	 */
	composeSummary(patterns: FailurePattern[]): string {
		const high = patterns.filter((p) => p.severity === "high").length;
		const medium = patterns.filter((p) => p.severity === "medium").length;
		const low = patterns.filter((p) => p.severity === "low").length;

		const parts: string[] = [];
		if (high > 0) parts.push(`${high} 个严重`);
		if (medium > 0) parts.push(`${medium} 个中等`);
		if (low > 0) parts.push(`${low} 个轻微`);
		return parts.length > 0 ? `发现 ${parts.join("、")} 问题` : "表现良好";
	}

	/**
	 * 类别标签（中文）
	 */
	private categoryLabel(category: PatternCategory): string {
		const labels: Record<PatternCategory, string> = {
			excessive_reads: "连续文件读取",
			long_model_calls: "模型调用延迟",
			frequent_compaction: "频繁上下文压缩",
			error_spike: "连续错误",
			tool_failure_rate: "工具失败率过高",
			recovery_exhaustion: "恢复机制耗尽",
			cost_inefficiency: "成本效率低下",
			context_underuse: "上下文利用率低",
			tool_sequence_inefficiency: "工具调用序列低效",
		};
		return labels[category] || category;
	}
}
