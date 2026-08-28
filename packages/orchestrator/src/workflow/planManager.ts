import {
	type WorkflowEvent,
	type WorkflowPlan,
	type WorkflowStep,
	WorkflowStepStatus,
} from "@xuancode/types";

export interface WorkflowPlanManagerOptions {
	maxSteps?: number;
	onEvent?: (event: WorkflowEvent) => void;
}

/**
 * WorkflowPlanManager — 工作流计划状态机
 *
 * 跟踪多步骤工作流的执行状态，管理步骤间的依赖关系，
 * 提供跨步骤上下文存储，生成 system prompt 注入的工作流状态摘要。
 *
 * 不依赖 TAOR 循环，可独立测试。
 */
export class WorkflowPlanManager {
	private plan: WorkflowPlan | null = null;
	private options: Required<WorkflowPlanManagerOptions>;

	constructor(options?: WorkflowPlanManagerOptions) {
		this.options = {
			maxSteps: options?.maxSteps ?? 20,
			onEvent: options?.onEvent ?? (() => {}),
		};
	}

	// ─── Plan lifecycle ───

	initPlan(
		summary: string,
		steps: Omit<WorkflowStep, "status" | "startedAt" | "completedAt">[],
	): void {
		const applicableSteps =
			steps.length > this.options.maxSteps
				? steps.slice(0, this.options.maxSteps)
				: steps;
		const now = Date.now();
		this.plan = {
			id: `wf-${now.toString(36)}`,
			summary,
			steps: applicableSteps.map((s) => ({
				...s,
				status: WorkflowStepStatus.PENDING,
				startedAt: undefined,
				completedAt: undefined,
			})),
			currentStepId: null,
			context: {},
			createdAt: now,
			updatedAt: now,
		};
		// 附带完整步骤列表：客户端（desktop/cli）依赖它在收到事件时立即渲染工作计划，而不是 0/0 空计划
		this.emit("plan_created", undefined, {
			stepCount: applicableSteps.length,
			summary,
			steps: this.plan.steps,
		});
	}

	updatePlan(
		updates: Partial<Pick<WorkflowPlan, "summary" | "context">>,
	): void {
		if (!this.plan) return;
		if (updates.summary !== undefined) this.plan.summary = updates.summary;
		if (updates.context) {
			this.plan.context = { ...this.plan.context, ...updates.context };
		}
		this.plan.updatedAt = Date.now();
	}

	clearPlan(): void {
		this.plan = null;
	}

	// ─── Step execution ───

	startStep(stepId: string): boolean {
		const step = this.getStep(stepId);
		if (!step) return false;
		if (step.status !== WorkflowStepStatus.PENDING) return false;
		step.status = WorkflowStepStatus.RUNNING;
		step.startedAt = Date.now();
		this.plan!.currentStepId = stepId;
		this.plan!.updatedAt = Date.now();
		this.emit("step_started", stepId, { label: step.label });
		return true;
	}

	completeStep(stepId: string, result?: string): void {
		const step = this.getStep(stepId);
		if (!step) return;
		step.status = WorkflowStepStatus.COMPLETED;
		step.completedAt = Date.now();
		if (result !== undefined) step.result = result;
		this.plan!.updatedAt = Date.now();

		// Auto-advance currentStepId to the next ready step
		const nextSteps = this.getNextSteps();
		this.plan!.currentStepId = nextSteps.length > 0 ? nextSteps[0].id : null;

		this.emit("step_completed", stepId, {
			label: step.label,
			result: result?.slice(0, 200),
		});

		// Check if all steps complete
		if (this.isComplete()) {
			this.emit("plan_completed", undefined, { summary: this.plan?.summary });
		}
	}

	failStep(stepId: string, error: string): void {
		const step = this.getStep(stepId);
		if (!step) return;
		step.status = WorkflowStepStatus.FAILED;
		step.completedAt = Date.now();
		step.error = error;
		this.plan!.updatedAt = Date.now();
		this.emit("step_failed", stepId, { label: step.label, error });
	}

	skipStep(stepId: string, reason?: string): void {
		const step = this.getStep(stepId);
		if (!step) return;
		step.status = WorkflowStepStatus.SKIPPED;
		step.completedAt = Date.now();
		step.result = reason ? `已跳过: ${reason}` : "已跳过";
		this.plan!.updatedAt = Date.now();
		this.emit("step_skipped", stepId, { label: step.label, reason });
	}

	// ─── Branching / Replan ───

	replaceSteps(
		newSteps: Omit<WorkflowStep, "status" | "startedAt" | "completedAt">[],
	): void {
		if (!this.plan) return;
		this.plan.steps = newSteps.map((s) => ({
			...s,
			status: WorkflowStepStatus.PENDING,
			startedAt: undefined,
			completedAt: undefined,
		}));
		this.plan.currentStepId = null;
		this.plan.updatedAt = Date.now();
		this.emit("replanned", undefined, { stepCount: newSteps.length });
	}

	// ─── Queries ───

	getCurrentStep(): WorkflowStep | null {
		if (!this.plan?.currentStepId) return null;
		return this.getStep(this.plan.currentStepId) ?? null;
	}

	getNextSteps(): WorkflowStep[] {
		if (!this.plan) return [];
		return this.plan.steps.filter(
			(step) =>
				step.status === WorkflowStepStatus.PENDING &&
				step.dependencies.every((depId) => {
					const dep = this.plan?.steps.find((s) => s.id === depId);
					return (
						dep &&
						(dep.status === WorkflowStepStatus.COMPLETED ||
							dep.status === WorkflowStepStatus.SKIPPED)
					);
				}),
		);
	}

	getStep(stepId: string): WorkflowStep | undefined {
		return this.plan?.steps.find((s) => s.id === stepId);
	}

	isComplete(): boolean {
		if (!this.plan || this.plan.steps.length === 0) return false;
		return this.plan.steps.every(
			(s) =>
				s.status === WorkflowStepStatus.COMPLETED ||
				s.status === WorkflowStepStatus.FAILED ||
				s.status === WorkflowStepStatus.SKIPPED,
		);
	}

	getProgress(): { completed: number; total: number; current: string | null } {
		if (!this.plan) return { completed: 0, total: 0, current: null };
		const completed = this.plan.steps.filter(
			(s) =>
				s.status === WorkflowStepStatus.COMPLETED ||
				s.status === WorkflowStepStatus.FAILED ||
				s.status === WorkflowStepStatus.SKIPPED,
		).length;
		return {
			completed,
			total: this.plan.steps.length,
			current: this.plan.currentStepId,
		};
	}

	getPlan(): Readonly<WorkflowPlan | null> {
		return this.plan ? { ...this.plan, steps: [...this.plan.steps] } : null;
	}

	// ─── Context store ───

	setContext(key: string, value: string): void {
		if (!this.plan) return;
		this.plan.context[key] = value;
		this.plan.updatedAt = Date.now();
	}

	getContext(key: string): string | undefined {
		return this.plan?.context[key];
	}

	// ─── Serialization ───

	toSystemPromptSection(): string {
		if (!this.plan) return "";

		const progress = this.getProgress();
		const lines: string[] = [
			"## 工作流状态",
			`计划: ${this.plan.summary}`,
			`进度: ${progress.completed}/${progress.total}`,
		];

		if (this.plan.steps.length > 0) {
			lines.push("");
			for (const step of this.plan.steps) {
				const statusIcon = this.stepStatusIcon(step.status);
				const depInfo =
					step.dependencies.length > 0
						? ` [依赖: ${step.dependencies.join(", ")}]`
						: "";
				lines.push(`${statusIcon} ${step.id}: ${step.label}${depInfo}`);
			}
		}

		if (Object.keys(this.plan.context).length > 0) {
			lines.push("");
			lines.push("上下文:");
			for (const [key, value] of Object.entries(this.plan.context)) {
				lines.push(`  ${key}: ${value.slice(0, 100)}`);
			}
		}

		// 状态由模型驱动：明确指示调用 update_step_status，否则 UI 永远停留在 0/N 步骤完成
		lines.push("");
		lines.push("工作流执行要求（必须遵守）:");
		lines.push(
			"- 每完成一个步骤，立即调用 update_step_status 将该步骤标记为 completed，并附上结果摘要。",
		);
		lines.push("- 步骤失败时调用 update_step_status 标记为 failed（附原因）。");
		lines.push("- 无需执行的步骤调用 update_step_status 标记为 skipped。");
		lines.push(
			`- 全部步骤完成（进度 ${progress.completed}/${progress.total}）后再总结并结束任务，不要提前结束。`,
		);

		return lines.join("\n");
	}

	/**
	 * 获取下个可执行步骤的提示文本（给 Agent 的简短指引）
	 */
	getNextStepHint(): string {
		const nextSteps = this.getNextSteps();
		if (nextSteps.length === 0) {
			if (this.isComplete()) return "所有步骤已完成。";
			if (!this.plan) return "";
			// Check if some steps are blocked by failed dependencies
			const blocked = this.plan.steps.filter(
				(s) =>
					s.status === WorkflowStepStatus.PENDING &&
					!s.dependencies.every((depId) => {
						const dep = this.plan?.steps.find((d) => d.id === depId);
						return dep && dep.status !== WorkflowStepStatus.FAILED;
					}),
			);
			if (blocked.length > 0) {
				return `以下步骤因依赖失败被阻塞: ${blocked.map((s) => s.id).join(", ")}。使用 branch_workflow 调整计划。`;
			}
			return "无待执行步骤。";
		}
		if (nextSteps.length === 1) {
			return `下一步: ${nextSteps[0].label} (${nextSteps[0].id})`;
		}
		return `以下步骤已就绪可并行执行: ${nextSteps.map((s) => `${s.label}(${s.id})`).join(", ")}`;
	}

	// ─── Private ───

	private emit(
		type: WorkflowEvent["type"],
		stepId?: string,
		data?: Record<string, unknown>,
	): void {
		this.options.onEvent({
			type,
			planId: this.plan?.id ?? "",
			stepId,
			timestamp: Date.now(),
			data,
		});
	}

	private stepStatusIcon(status: WorkflowStepStatus): string {
		switch (status) {
			case WorkflowStepStatus.PENDING:
				return "○";
			case WorkflowStepStatus.RUNNING:
				return "◉";
			case WorkflowStepStatus.COMPLETED:
				return "✅";
			case WorkflowStepStatus.FAILED:
				return "❌";
			case WorkflowStepStatus.SKIPPED:
				return "⏭️";
		}
	}
}
