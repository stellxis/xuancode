import type { ToolCallParams, ToolResult } from "@xuancode/types";
import type { WorkflowPlanManager } from "./planManager";

export interface WorkflowToolRegistration {
	def: {
		type: string;
		name: string;
		description: string;
		parameters: Array<{
			name: string;
			type: string;
			description: string;
			required: boolean;
			enumValues?: string[];
		}>;
		examples: Array<{
			description: string;
			params: Record<string, unknown>;
		}>;
		alwaysLoad: boolean;
		category: string;
	};
	handler: (params: ToolCallParams) => Promise<ToolResult>;
}

/**
 * Create all workflow tool definitions bound to a specific plan manager.
 * Optionally accepts a toolManager for tools that need dispatch (e.g. parallel_invoke).
 */
export function createWorkflowToolDefinitions(
	manager: WorkflowPlanManager,
	toolManager?: { dispatch: (tc: ToolCallParams) => Promise<ToolResult> },
): WorkflowToolRegistration[] {
	return [
		createPlanWorkflowTool(manager),
		createUpdateStepStatusTool(manager),
		createGetWorkflowStatusTool(manager),
		createSetWorkflowContextTool(manager),
		createBranchWorkflowTool(manager),
		createParallelInvokeTool(manager, toolManager),
	];
}

function createPlanWorkflowTool(
	manager: WorkflowPlanManager,
): WorkflowToolRegistration {
	return {
		def: {
			type: "plan_workflow",
			name: "plan_workflow",
			description:
				"定义或更新工作计划。包含工作流中所有步骤及其依赖关系。调用后系统将跟踪每一步的执行状态。" +
				"步骤间通过 dependencies 表达依赖关系，无依赖的步骤可以并行执行。",
			parameters: [
				{
					name: "summary",
					type: "string",
					description: "工作计划的高层摘要",
					required: true,
				},
				{
					name: "steps",
					type: "array",
					description:
						"步骤列表。每个步骤: { id: 唯一标识, label: 简短名称, description: 具体描述, dependencies: 前置步骤ID数组 }",
					required: true,
				},
			],
			examples: [
				{
					description: "规划工作流",
					params: {
						summary: "实现用户登录功能",
						steps: [
							{
								id: "step-1",
								label: "设计数据库模型",
								description: "创建用户表和会话表",
								dependencies: [],
							},
							{
								id: "step-2",
								label: "实现登录API",
								description: "编写登录接口逻辑",
								dependencies: ["step-1"],
							},
							{
								id: "step-3",
								label: "编写前端页面",
								description: "登录表单页面",
								dependencies: ["step-2"],
							},
						],
					},
				},
			],
			alwaysLoad: true,
			category: "earth",
		},
		handler: async (params) => {
			const { summary, steps } = params;
			if (!summary || !steps || !Array.isArray(steps)) {
				return {
					success: false,
					data: "",
					error: "缺少必要参数: summary, steps",
				};
			}
			manager.initPlan(summary as string, steps as any[]);
			const nextSteps = manager.getNextSteps();
			return {
				success: true,
				data: `工作流计划已创建: ${summary}\n共 ${(steps as any[]).length} 个步骤\n${
					nextSteps.length > 0
						? `下一步: ${nextSteps.map((s) => s.label).join(", ")}`
						: "全部步骤已完成"
				}`,
			};
		},
	};
}

function createUpdateStepStatusTool(
	manager: WorkflowPlanManager,
): WorkflowToolRegistration {
	return {
		def: {
			type: "update_step_status",
			name: "update_step_status",
			description:
				"更新工作流中某个步骤的状态。当步骤完成、失败或需要跳过时调用。",
			parameters: [
				{
					name: "stepId",
					type: "string",
					description: "步骤 ID",
					required: true,
				},
				{
					name: "status",
					type: "string",
					description: "新状态: completed / failed / skipped",
					required: true,
					enumValues: ["completed", "failed", "skipped"],
				},
				{
					name: "result",
					type: "string",
					description: "执行结果摘要（完成/失败时填写）",
					required: false,
				},
			],
			examples: [
				{
					description: "标记步骤完成",
					params: {
						stepId: "step-1",
						status: "completed",
						result: "数据库表创建成功",
					},
				},
			],
			alwaysLoad: true,
			category: "earth",
		},
		handler: async (params) => {
			const stepId = params.stepId as string;
			const status = params.status as string;
			const result = params.result as string | undefined;

			if (!stepId || !status) {
				return {
					success: false,
					data: "",
					error: "缺少必要参数: stepId, status",
				};
			}

			switch (status) {
				case "completed":
					manager.completeStep(stepId, result);
					break;
				case "failed":
					manager.failStep(stepId, result || "未知错误");
					break;
				case "skipped":
					manager.skipStep(stepId, result);
					break;
				default:
					return {
						success: false,
						data: "",
						error: `不支持的状态: ${status}，可选: completed, failed, skipped`,
					};
			}

			const nextSteps = manager.getNextSteps();
			const msg =
				nextSteps.length > 0
					? `下一步: ${nextSteps.map((s) => s.label).join(", ")}`
					: manager.isComplete()
						? "所有步骤已完成!"
						: "无待执行步骤（可能有步骤因依赖失败被阻塞）";

			return {
				success: true,
				data: `步骤 ${stepId} 已标记为 ${status}\n${msg}`,
			};
		},
	};
}

function createGetWorkflowStatusTool(
	manager: WorkflowPlanManager,
): WorkflowToolRegistration {
	return {
		def: {
			type: "get_workflow_status",
			name: "get_workflow_status",
			description:
				"查询当前工作流执行状态，包括进度、当前步骤、已完成步骤和上下文数据。",
			parameters: [],
			examples: [{ description: "查询工作流状态", params: {} }],
			alwaysLoad: true,
			category: "earth",
		},
		handler: async () => {
			const plan = manager.getPlan();
			if (!plan) {
				return { success: true, data: "当前无活跃工作流计划。" };
			}

			const progress = manager.getProgress();
			const curStep = manager.getCurrentStep();
			const nextSteps = manager.getNextSteps();

			const lines: string[] = [
				`计划: ${plan.summary}`,
				`进度: ${progress.completed}/${progress.total}`,
				`完成: ${progress.completed === progress.total}`,
			];
			if (curStep) lines.push(`当前步骤: ${curStep.label} (${curStep.id})`);
			if (nextSteps.length > 0) {
				lines.push(
					`待执行: ${nextSteps.map((s) => `${s.label}(${s.id})`).join(", ")}`,
				);
			}
			if (Object.keys(plan.context).length > 0) {
				lines.push("上下文:");
				for (const [k, v] of Object.entries(plan.context)) {
					lines.push(`  ${k}: ${v.slice(0, 100)}`);
				}
			}

			return { success: true, data: lines.join("\n") };
		},
	};
}

function createSetWorkflowContextTool(
	manager: WorkflowPlanManager,
): WorkflowToolRegistration {
	return {
		def: {
			type: "set_workflow_context",
			name: "set_workflow_context",
			description: "在工作流上下文中存储键值对数据，用于跨步骤传递信息。",
			parameters: [
				{
					name: "key",
					type: "string",
					description: "键名",
					required: true,
				},
				{
					name: "value",
					type: "string",
					description: "值",
					required: true,
				},
			],
			examples: [
				{
					description: "存储用户ID",
					params: { key: "userId", value: "42" },
				},
			],
			alwaysLoad: true,
			category: "earth",
		},
		handler: async (params) => {
			const key = params.key as string;
			const value = params.value as string;
			if (!key || value === undefined) {
				return { success: false, data: "", error: "缺少必要参数: key, value" };
			}
			manager.setContext(key, value);
			return {
				success: true,
				data: `上下文已设置: ${key} = ${value.slice(0, 200)}`,
			};
		},
	};
}

function createBranchWorkflowTool(
	manager: WorkflowPlanManager,
): WorkflowToolRegistration {
	return {
		def: {
			type: "branch_workflow",
			name: "branch_workflow",
			description:
				"动态重规划工作流的剩余步骤。当执行过程中发现原计划不合适时，用新的步骤列表替换剩余的步骤。" +
				"已完成的步骤不受影响。",
			parameters: [
				{
					name: "newSteps",
					type: "array",
					description:
						"新的步骤列表（替换全部剩余步骤）。格式同 plan_workflow 的 steps。",
					required: true,
				},
			],
			examples: [
				{
					description: "发现 bug 后插入修复步骤",
					params: {
						newSteps: [
							{
								id: "fix-1",
								label: "修复登录 bug",
								description: "排查并修复 token 过期问题",
								dependencies: [],
							},
							{
								id: "step-2",
								label: "继续实现注册",
								description: "实现注册功能",
								dependencies: ["fix-1"],
							},
						],
					},
				},
			],
			alwaysLoad: true,
			category: "earth",
		},
		handler: async (params) => {
			const newSteps = params.newSteps;
			if (!newSteps || !Array.isArray(newSteps)) {
				return { success: false, data: "", error: "缺少 newSteps 参数" };
			}
			manager.replaceSteps(newSteps as any[]);
			return {
				success: true,
				data: `工作流已重新规划，现有 ${(newSteps as any[]).length} 个步骤。${manager.getNextStepHint()}`,
			};
		},
	};
}

function createParallelInvokeTool(
	manager: WorkflowPlanManager,
	toolManager?: { dispatch: (tc: ToolCallParams) => Promise<ToolResult> },
): WorkflowToolRegistration {
	return {
		def: {
			type: "parallel_invoke",
			name: "parallel_invoke",
			description:
				"在同一轮中并行执行多个工具调用。适用于无依赖关系的独立操作（如同时读取多个文件）。",
			parameters: [
				{
					name: "tasks",
					type: "array",
					description:
						"工具调用列表，每个元素包含 type(工具类型) 和该工具的参数",
					required: true,
				},
			],
			examples: [
				{
					description: "并行读取两个文件",
					params: {
						tasks: [
							{ type: "read_file", path: "package.json" },
							{ type: "read_file", path: "tsconfig.json" },
						],
					},
				},
			],
			alwaysLoad: true,
			category: "earth",
		},
		handler: async (params) => {
			const tasks = params.tasks as Array<Record<string, unknown>> | undefined;
			if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
				return { success: false, data: "", error: "缺少 tasks 参数或为空" };
			}

			if (!toolManager) {
				return {
					success: false,
					data: "",
					error: "parallel_invoke 在当前执行环境中不可用",
				};
			}

			const results = await Promise.allSettled(
				tasks.map((t) => toolManager.dispatch(t as ToolCallParams)),
			);

			const formatted = results
				.map((r, i) => {
					const task = tasks[i];
					if (r.status === "fulfilled") {
						return `[${task.type}] 成功: ${(r.value.data as string)?.slice(0, 300) || "(无数据)"}`;
					}
					return `[${task.type}] 失败: ${r.reason?.message || "未知错误"}`;
				})
				.join("\n");

			return {
				success: true,
				data: `并行执行结果 (${tasks.length} 个任务):\n${formatted}`,
			};
		},
	};
}
