/**
 * /plan 命令共享业务逻辑
 * 可被 Ink App (App.tsx) 和 standalone commander 命令共同使用
 */

import type {
	DaemonClient,
	StreamCallbacks,
	TaskResult,
	WorkflowEvent,
} from "../daemonClient";

// ===== Types =====

export interface PlanStep {
	id: string;
	label: string;
	description?: string;
	status: "pending" | "running" | "completed" | "failed" | "skipped";
	error?: string;
}

export interface PlanState {
	steps: PlanStep[];
	summary: string;
	totalSteps: number;
	completedSteps: number;
	status: "idle" | "running" | "completed" | "failed";
}

export interface PlanOpts {
	mode: string;
	maxTurns: number;
	maxContinuations?: number;
	compactLevel?: number;
	provider?: string;
	modelName?: string;
}

export interface PlanCallbacks {
	onStateChange: (state: PlanState) => void;
	onWorkflowEvent?: (event: WorkflowEvent) => void;
	onToken?: (fullText: string) => void;
	onError?: (error: string) => void;
	onFinalAnswer?: (answer: string) => void;
	/** 任务已创建（返回 taskId，供 respondInput 使用） */
	onTaskCreated?: (taskId: string) => void;
	/** 模型调用 ask_user 工具，等待用户选择分支 */
	onAskUser?: (payload: { question: string; options?: string[] }) => void;
	/** 用户已通过 respondInput 提交回答 */
	onInputResumed?: (payload: { answer: string }) => void;
}

// ===== Prompt wrapper =====

export function wrapPlanPrompt(task: string): string {
	return `请按以下要求执行此任务：\n\n${task}\n\n要求：\n1. 先制定详细的实施计划，按阶段编号（P0、P1、P2...）或 Step N 格式列出每个步骤，每步包含简短标题和说明\n2. 然后逐个步骤执行，每完成一步在输出中标记该步骤完成\n3. 执行过程中遇到问题及时修复并继续\n4. 所有步骤完成后输出总结`;
}

// ===== Auto promote =====

/**
 * 长任务自动升级启发式：输入像多步骤任务时启用工作流。
 * 交互（App 连接/内嵌）与管道模式共用，保持"全自动"体验——无需手动 flag。
 */
export function shouldAutoPromoteToPlan(input: string): boolean {
	const trimmed = input.trim();
	if (trimmed.length < 80) return false;
	const planIntent =
		/(?:请按步骤|分阶段|逐步|按以下步骤|按如下步骤|分步骤|逐步执行|step\s*by\s*step|分多个阶段)/i;
	if (planIntent.test(trimmed)) return true;
	const hasPhaseMark =
		/(?:^|\n)\s*(?:P\d+(?:-\d+)?|Phase\s+\d+|阶段\s*[一二三四五六七八九十\d]+|Step\s+\d+|步骤\s*\d+)\s*[:：.\-、)]/im.test(
			trimmed,
		);
	if (hasPhaseMark && trimmed.length > 120) return true;
	if (trimmed.length > 240) {
		const codeRatio =
			(trimmed.match(/[{}[\]();:=/\\]/g) || []).length / trimmed.length;
		if (codeRatio < 0.08) return true;
	}
	return false;
}

// ===== State reducer =====

export function createPlanStateReducer(onChange: (state: PlanState) => void) {
	const state: PlanState = {
		steps: [],
		summary: "",
		totalSteps: 0,
		completedSteps: 0,
		status: "idle",
	};

	function emit(): void {
		onChange({ ...state, steps: [...state.steps] });
	}

	function handleWorkflowEvent(event: WorkflowEvent): void {
		switch (event.type) {
			case "plan_created": {
				const steps = (event.data?.steps || []).map((step: any, i: number) => ({
					id: step.id || `step-${i}`,
					label: step.label || `步骤 ${i + 1}`,
					description: step.description,
					status: "pending" as const,
				}));
				state.steps = steps;
				state.summary = event.data?.summary || "";
				state.totalSteps = steps.length;
				state.completedSteps = 0;
				state.status = "running";
				emit();
				break;
			}
			case "step_started": {
				state.steps = state.steps.map((s) =>
					s.id === event.stepId ? { ...s, status: "running" as const } : s,
				);
				emit();
				break;
			}
			case "step_completed": {
				// 标记完成 + 自动激活下一个 pending 步骤（等待 daemon step_started 前的 UX 平滑过渡）
				let activated = false;
				state.steps = state.steps.map((s) => {
					if (s.id === event.stepId) {
						return { ...s, status: "completed" as const };
					}
					if (!activated && s.status === "pending") {
						activated = true;
						return { ...s, status: "running" as const };
					}
					return s;
				});
				state.completedSteps = state.steps.filter(
					(s) => s.status === "completed",
				).length;
				emit();
				break;
			}
			case "step_failed": {
				state.steps = state.steps.map((s) =>
					s.id === event.stepId
						? { ...s, status: "failed" as const, error: event.data?.error }
						: s,
				);
				state.status = "failed";
				emit();
				break;
			}
			case "step_skipped": {
				state.steps = state.steps.map((s) =>
					s.id === event.stepId ? { ...s, status: "skipped" as const } : s,
				);
				emit();
				break;
			}
			case "replanned": {
				const newSteps = (event.data?.steps || []).map(
					(step: any, i: number) => ({
						id: step.id || `step-${i}`,
						label: step.label || `步骤 ${i + 1}`,
						description: step.description,
						status: "pending" as const,
					}),
				);
				state.steps = newSteps;
				state.totalSteps = newSteps.length;
				state.completedSteps = 0;
				emit();
				break;
			}
			case "plan_completed": {
				state.steps = state.steps.map((s) =>
					s.status === "running" || s.status === "pending"
						? { ...s, status: "completed" as const }
						: s,
				);
				state.completedSteps = state.steps.filter(
					(s) => s.status === "completed",
				).length;
				state.status = "completed";
				emit();
				break;
			}
		}
	}

	return { handleWorkflowEvent };
}

// ===== Task submission =====

export async function submitPlanTask(
	taskInput: string,
	daemonClient: DaemonClient | undefined,
	workDir: string,
	opts: PlanOpts,
	callbacks: PlanCallbacks,
): Promise<void> {
	const enhancedInput = wrapPlanPrompt(taskInput);

	const daemonCallbacks: StreamCallbacks = {
		onWorkflow: (event) => callbacks.onWorkflowEvent?.(event),
		onError: (msg) => callbacks.onError?.(msg),
		onErrorFatal: (err) => callbacks.onError?.(err),
		onComplete: (result) => {
			callbacks.onFinalAnswer?.(result.finalAnswer);
		},
		onTaskCreated: (taskId) => callbacks.onTaskCreated?.(taskId),
		onAskUser: (payload) => callbacks.onAskUser?.(payload),
		onInputResumed: (payload) => callbacks.onInputResumed?.(payload),
	};

	if (daemonClient) {
		// === Daemon mode ===
		await daemonClient.runTask(
			enhancedInput,
			{
				mode: opts.mode as any,
				maxTurns: opts.maxTurns,
				maxContinuations: opts.maxContinuations ?? 0,
				compactLevel: 1,
				compactThreshold: 0.7,
				enableWorkflow: true,
				enableCompact: true,
			},
			daemonCallbacks,
		);
		return;
	}

	// === Embedded mode (in-process taorLoop) ===
	const { runTaorLoop } = await import("@xuancode/orchestrator");
	const { createModelAdapter } = await import("@xuancode/model-adapter");
	const model = createModelAdapter(opts.provider || "deepseek", {
		modelName: opts.modelName || "deepseek-v4-flash",
	});

	const hookCallbacks: Record<string, (event: any) => void> = {};
	if (callbacks.onWorkflowEvent) {
		hookCallbacks.WorkflowEvent = (event: any) => {
			callbacks.onWorkflowEvent?.(event as WorkflowEvent);
		};
	}

	await runTaorLoop(enhancedInput, {
		model,
		workDir,
		config: {
			mode: opts.mode as any,
			maxTurns: opts.maxTurns,
			maxContinuations: opts.maxContinuations ?? 0,
			compactLevel: 1,
			compactThreshold: 0.7,
		},
		enableWorkflow: true,
		onHook: (event, context) => {
			const cb = hookCallbacks[event as string];
			if (cb) cb(context);
		},
		onTurn: () => {},
		onToolCall: () => {},
		onToken: (_token, fullText) => callbacks.onToken?.(fullText),
		onError: () => {},
	});

	callbacks.onFinalAnswer?.("");
}
