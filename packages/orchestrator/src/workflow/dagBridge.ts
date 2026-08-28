import { WorkflowStepStatus } from "@xuancode/types";
import type { DagNode } from "../dag/types";
import type { WorkflowPlanManager } from "./planManager";

/**
 * 将 DAG 节点列表转换为 WorkflowPlan 并播种到管理器。
 * 这样允许 DAG 分解结果成为初始工作流计划，Agent 可在
 * TAOR 循环中动态调整它。
 */
export function seedFromDag(
	manager: WorkflowPlanManager,
	dagNodes: DagNode[],
	summary: string,
): void {
	const steps = dagNodes.map((node) => ({
		id: node.id,
		label: node.label,
		description: node.instruction,
		dependencies: node.dependencies,
		subAgentType: node.subAgentType as any,
	}));

	manager.initPlan(summary, steps);
}

/**
 * 将工作流状态同步回 DAG 节点状态映射。
 * 当需要从工作流模式回退到 DAG 执行器时使用。
 */
export function syncToDagStatuses(
	manager: WorkflowPlanManager,
): Map<string, "pending" | "running" | "completed" | "failed" | "skipped"> {
	const plan = manager.getPlan();
	if (!plan) return new Map();

	const statusMap = new Map<
		string,
		"pending" | "running" | "completed" | "failed" | "skipped"
	>();
	for (const step of plan.steps) {
		statusMap.set(step.id, step.status as any);
	}
	return statusMap;
}
