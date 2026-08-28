/**
 * @xuancode/optimizer — 自改进分析引擎
 *
 * 基于 Phase 4 Telemetry 数据，提供 Agent 执行分析的失败模式检测、
 * 跨 Session 趋势分析和 Prompt 优化建议生成。
 *
 * ## 安全约束
 * - 所有分析结果仅供查看，默认不自动注入 System Prompt
 * - 自动注入功能需用户手动开启（feature.autoOptimize）
 * - 不修改任何 Agent 执行逻辑
 */

export { FailureAnalyzer } from "./failureAnalyzer";
export { SessionAnalyzer } from "./sessionAnalyzer";
export { PromptOptimizer } from "./promptOptimizer";
export type * from "./types";
