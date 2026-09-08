import { describe, expect, it, vi } from "vitest";
import {
	type PlanState,
	createPlanStateReducer,
	shouldAutoPromoteToPlan,
	submitPlanTask,
	wrapPlanPrompt,
} from "./plan";

describe("shouldAutoPromoteToPlan", () => {
	it("短输入（<80 字符）不升级", () => {
		expect(shouldAutoPromoteToPlan("修个 bug")).toBe(false);
	});

	it("含计划意图词（逐步/分阶段/step by step）→ 升级", () => {
		const long = `${"这个任务比较复杂，".repeat(15)}请逐步执行并汇报`;
		expect(shouldAutoPromoteToPlan(long)).toBe(true);
	});

	it("含 P0/Phase/Step/阶段 标记且够长 → 升级", () => {
		const marked = `${"重构数据层。".repeat(20)}\nP0-1: 先改模型\nP1-2: 再迁移`;
		expect(shouldAutoPromoteToPlan(marked)).toBe(true);
	});

	it("超长自然语言（>240 字符、非代码）→ 升级", () => {
		const prose = "请帮我全面梳理这个项目的鉴权流程，".repeat(20);
		expect(shouldAutoPromoteToPlan(prose)).toBe(true);
	});

	it("超长但代码占比高 → 不升级（多半是贴代码提问）", () => {
		const code = `${"function a() { return { x: 1 }; }\n".repeat(20)}`;
		expect(shouldAutoPromoteToPlan(code)).toBe(false);
	});
});

describe("wrapPlanPrompt", () => {
	it("包含任务原文与计划格式要求", () => {
		const prompt = wrapPlanPrompt("实现登录功能");
		expect(prompt).toContain("实现登录功能");
		expect(prompt).toContain("P0、P1、P2");
		expect(prompt).toContain("Step N");
	});
});

describe("createPlanStateReducer", () => {
	function setup() {
		const states: PlanState[] = [];
		const reducer = createPlanStateReducer((s) => states.push(s));
		return { reducer, states };
	}

	it("plan_created 初始化步骤并进入 running", () => {
		const { reducer, states } = setup();
		reducer.handleWorkflowEvent({
			type: "plan_created",
			data: {
				summary: "三步走",
				steps: [
					{ id: "s1", label: "第一步" },
					{ id: "s2", label: "第二步", description: "详细说明" },
				],
			},
		} as any);
		const last = states.at(-1)!;
		expect(last.status).toBe("running");
		expect(last.summary).toBe("三步走");
		expect(last.totalSteps).toBe(2);
		expect(last.completedSteps).toBe(0);
		expect(last.steps[0]).toMatchObject({
			id: "s1",
			label: "第一步",
			status: "pending",
		});
		// 缺 id/label 时按序号兜底
		expect(last.steps[1].description).toBe("详细说明");
	});

	it("plan_created 步骤缺 id 时按索引生成", () => {
		const { reducer, states } = setup();
		reducer.handleWorkflowEvent({
			type: "plan_created",
			data: { steps: [{}, {}] },
		} as any);
		expect(states.at(-1)!.steps.map((s) => s.id)).toEqual(["step-0", "step-1"]);
	});

	it("step_started → step_completed 状态流转并累计 completedSteps", () => {
		const { reducer, states } = setup();
		reducer.handleWorkflowEvent({
			type: "plan_created",
			data: { steps: [{ id: "s1" }, { id: "s2" }] },
		} as any);
		reducer.handleWorkflowEvent({ type: "step_started", stepId: "s1" } as any);
		expect(states.at(-1)!.steps[0].status).toBe("running");

		reducer.handleWorkflowEvent({
			type: "step_completed",
			stepId: "s1",
		} as any);
		const last = states.at(-1)!;
		expect(last.steps[0].status).toBe("completed");
		expect(last.completedSteps).toBe(1);
	});

	it("step_failed 标记失败并将整体状态置为 failed", () => {
		const { reducer, states } = setup();
		reducer.handleWorkflowEvent({
			type: "plan_created",
			data: { steps: [{ id: "s1" }] },
		} as any);
		reducer.handleWorkflowEvent({
			type: "step_failed",
			stepId: "s1",
			data: { error: "boom" },
		} as any);
		const last = states.at(-1)!;
		expect(last.status).toBe("failed");
		expect(last.steps[0].status).toBe("failed");
		expect(last.steps[0].error).toBe("boom");
	});

	it("step_completed 自动激活下一个 pending 步骤", () => {
		const { reducer, states } = setup();
		reducer.handleWorkflowEvent({
			type: "plan_created",
			data: { steps: [{ id: "s1" }, { id: "s2" }, { id: "s3" }] },
		} as any);
		reducer.handleWorkflowEvent({
			type: "step_completed",
			stepId: "s1",
		} as any);
		const last = states.at(-1)!;
		expect(last.steps[0].status).toBe("completed");
		expect(last.steps[1].status).toBe("running");
		expect(last.steps[2].status).toBe("pending");
	});

	it("step_skipped 标记 skipped 且不计入 completedSteps", () => {
		const { reducer, states } = setup();
		reducer.handleWorkflowEvent({
			type: "plan_created",
			data: { steps: [{ id: "s1" }, { id: "s2" }] },
		} as any);
		reducer.handleWorkflowEvent({ type: "step_skipped", stepId: "s2" } as any);
		const last = states.at(-1)!;
		expect(last.steps[1].status).toBe("skipped");
		expect(last.completedSteps).toBe(0);
	});

	it("replanned 重置步骤列表与进度", () => {
		const { reducer, states } = setup();
		reducer.handleWorkflowEvent({
			type: "plan_created",
			data: { steps: [{ id: "s1" }] },
		} as any);
		reducer.handleWorkflowEvent({
			type: "step_completed",
			stepId: "s1",
		} as any);
		expect(states.at(-1)!.completedSteps).toBe(1);

		reducer.handleWorkflowEvent({
			type: "replanned",
			data: { steps: [{ id: "r1" }, { id: "r2" }, { id: "r3" }] },
		} as any);
		const last = states.at(-1)!;
		expect(last.steps.map((s) => s.id)).toEqual(["r1", "r2", "r3"]);
		expect(last.totalSteps).toBe(3);
		expect(last.completedSteps).toBe(0);
	});

	it("plan_completed 收敛未完成步骤并置整体 completed", () => {
		const { reducer, states } = setup();
		reducer.handleWorkflowEvent({
			type: "plan_created",
			data: { steps: [{ id: "s1" }, { id: "s2" }, { id: "s3" }] },
		} as any);
		reducer.handleWorkflowEvent({
			type: "step_completed",
			stepId: "s1",
		} as any);
		reducer.handleWorkflowEvent({ type: "step_started", stepId: "s2" } as any);
		reducer.handleWorkflowEvent({ type: "plan_completed" } as any);
		const last = states.at(-1)!;
		expect(last.status).toBe("completed");
		expect(last.steps.map((s) => s.status)).toEqual([
			"completed",
			"completed",
			"completed",
		]);
		expect(last.completedSteps).toBe(3);
	});

	it("plan_completed 不覆盖 failed 步骤的状态", () => {
		const { reducer, states } = setup();
		reducer.handleWorkflowEvent({
			type: "plan_created",
			data: { steps: [{ id: "s1" }, { id: "s2" }] },
		} as any);
		reducer.handleWorkflowEvent({
			type: "step_failed",
			stepId: "s1",
			data: { error: "x" },
		} as any);
		reducer.handleWorkflowEvent({ type: "plan_completed" } as any);
		const last = states.at(-1)!;
		expect(last.steps[0].status).toBe("failed");
		expect(last.steps[1].status).toBe("completed");
	});

	it("每次事件都会触发 onChange 回调", () => {
		const onChange = vi.fn();
		const reducer = createPlanStateReducer(onChange);
		reducer.handleWorkflowEvent({
			type: "plan_created",
			data: { steps: [{ id: "s1" }] },
		} as any);
		reducer.handleWorkflowEvent({ type: "step_started", stepId: "s1" } as any);
		expect(onChange).toHaveBeenCalledTimes(2);
	});
});

describe("submitPlanTask（daemon 模式）", () => {
	function makeMockClient() {
		const captured: { callbacks: any } = { callbacks: null };
		return {
			captured,
			runTask: vi.fn(
				async (
					_input: string,
					_config: any,
					callbacks: any,
				): Promise<{ finalAnswer: string }> => {
					captured.callbacks = callbacks;
					return { finalAnswer: "done" };
				},
			),
		} as any;
	}

	const baseCallbacks = {
		onStateChange: vi.fn(),
	};

	it("透传 onTaskCreated / onAskUser / onInputResumed 到 daemon 回调", async () => {
		const client = makeMockClient();
		const onTaskCreated = vi.fn();
		const onAskUser = vi.fn();
		const onInputResumed = vi.fn();

		await submitPlanTask(
			"任务",
			client,
			"/tmp",
			{ mode: "plan", maxTurns: 5 },
			{
				...baseCallbacks,
				onTaskCreated,
				onAskUser,
				onInputResumed,
			},
		);

		expect(client.runTask).toHaveBeenCalledTimes(1);
		// daemonCallbacks 已挂接三个回调
		client.captured.callbacks.onTaskCreated("task-1");
		expect(onTaskCreated).toHaveBeenCalledWith("task-1");
		client.captured.callbacks.onAskUser({
			question: "选哪个？",
			options: ["A", "B"],
		});
		expect(onAskUser).toHaveBeenCalledWith({
			question: "选哪个？",
			options: ["A", "B"],
		});
		client.captured.callbacks.onInputResumed({ answer: "A" });
		expect(onInputResumed).toHaveBeenCalledWith({ answer: "A" });
	});

	it("daemon 模式 config 携带 enableWorkflow", async () => {
		const client = makeMockClient();
		await submitPlanTask(
			"任务",
			client,
			"/tmp",
			{ mode: "plan", maxTurns: 5 },
			{
				...baseCallbacks,
			},
		);
		expect(client.runTask.mock.calls[0][1]).toMatchObject({
			enableWorkflow: true,
			mode: "plan",
			maxTurns: 5,
		});
	});
});
