import { WorkflowStepStatus } from "@xuancode/types";
import { describe, expect, it, vi } from "vitest";
import { WorkflowPlanManager } from "./planManager";

describe("WorkflowPlanManager", () => {
	// ─── Empty / no plan ───

	it("should report no progress when no plan exists", () => {
		const mgr = new WorkflowPlanManager();
		expect(mgr.getProgress()).toEqual({
			completed: 0,
			total: 0,
			current: null,
		});
		expect(mgr.isComplete()).toBe(false);
		expect(mgr.getPlan()).toBeNull();
		expect(mgr.toSystemPromptSection()).toBe("");
		expect(mgr.getNextStepHint()).toBe("");
	});

	// ─── initPlan ───

	it("should initialize a plan with steps", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("测试计划", [
			{
				id: "step-1",
				label: "第一步",
				description: "做第一件事",
				dependencies: [],
			},
			{
				id: "step-2",
				label: "第二步",
				description: "做第二件事",
				dependencies: ["step-1"],
			},
		]);

		const plan = mgr.getPlan();
		expect(plan).not.toBeNull();
		expect(plan?.summary).toBe("测试计划");
		expect(plan?.steps).toHaveLength(2);
		expect(plan?.steps[0].status).toBe(WorkflowStepStatus.PENDING);
		expect(plan?.steps[0].dependencies).toEqual([]);
		expect(plan?.steps[1].dependencies).toEqual(["step-1"]);
		expect(mgr.getProgress()).toEqual({
			completed: 0,
			total: 2,
			current: null,
		});
		expect(mgr.isComplete()).toBe(false);
	});

	it("should limit steps to maxSteps", () => {
		const mgr = new WorkflowPlanManager({ maxSteps: 3 });
		mgr.initPlan("过多步骤", [
			{ id: "s1", label: "1", description: "", dependencies: [] },
			{ id: "s2", label: "2", description: "", dependencies: [] },
			{ id: "s3", label: "3", description: "", dependencies: [] },
			{ id: "s4", label: "4", description: "", dependencies: [] },
		]);
		expect(mgr.getPlan()?.steps).toHaveLength(3);
	});

	it("should emit plan_created event", () => {
		const onEvent = vi.fn();
		const mgr = new WorkflowPlanManager({ onEvent });
		mgr.initPlan("测试", [
			{ id: "s1", label: "1", description: "", dependencies: [] },
		]);
		expect(onEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "plan_created",
				planId: expect.any(String),
			}),
		);
	});

	// ─── getNextSteps ───

	it("should return step-1 as next when no dependencies are met", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("串行计划", [
			{ id: "step-1", label: "第一步", description: "", dependencies: [] },
			{
				id: "step-2",
				label: "第二步",
				description: "",
				dependencies: ["step-1"],
			},
			{
				id: "step-3",
				label: "第三步",
				description: "",
				dependencies: ["step-2"],
			},
		]);

		const next = mgr.getNextSteps();
		expect(next).toHaveLength(1);
		expect(next[0].id).toBe("step-1");
	});

	it("should return parallel steps when dependencies are met", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("并行计划", [
			{ id: "a", label: "A", description: "", dependencies: [] },
			{ id: "b", label: "B", description: "", dependencies: [] },
			{ id: "c", label: "C", description: "", dependencies: ["a", "b"] },
		]);

		expect(mgr.getNextSteps()).toHaveLength(2);
		const nextIds = mgr
			.getNextSteps()
			.map((s) => s.id)
			.sort();
		expect(nextIds).toEqual(["a", "b"]);
	});

	it("should return step-2 after step-1 is completed", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("串行", [
			{ id: "s1", label: "1", description: "", dependencies: [] },
			{ id: "s2", label: "2", description: "", dependencies: ["s1"] },
		]);

		mgr.completeStep("s1");
		const next = mgr.getNextSteps();
		expect(next).toHaveLength(1);
		expect(next[0].id).toBe("s2");
	});

	// ─── Step lifecycle ───

	it("should start a step and update status", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("测试", [
			{ id: "s1", label: "1", description: "", dependencies: [] },
		]);

		const started = mgr.startStep("s1");
		expect(started).toBe(true);
		expect(mgr.getStep("s1")?.status).toBe(WorkflowStepStatus.RUNNING);
		expect(mgr.getStep("s1")?.startedAt).toBeDefined();
		expect(mgr.getProgress().current).toBe("s1");
	});

	it("should not start a non-existent step", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("测试", [
			{ id: "s1", label: "1", description: "", dependencies: [] },
		]);
		expect(mgr.startStep("nonexistent")).toBe(false);
	});

	it("should complete a step and advance currentStepId", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("串行", [
			{ id: "s1", label: "1", description: "", dependencies: [] },
			{ id: "s2", label: "2", description: "", dependencies: ["s1"] },
		]);

		mgr.completeStep("s1", "结果1");
		expect(mgr.getStep("s1")?.status).toBe(WorkflowStepStatus.COMPLETED);
		expect(mgr.getStep("s1")?.result).toBe("结果1");
		expect(mgr.getProgress().current).toBe("s2");
	});

	it("should fail a step", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("测试", [
			{ id: "s1", label: "1", description: "", dependencies: [] },
		]);

		mgr.failStep("s1", "出错啦");
		expect(mgr.getStep("s1")?.status).toBe(WorkflowStepStatus.FAILED);
		expect(mgr.getStep("s1")?.error).toBe("出错啦");
	});

	it("should skip a step", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("测试", [
			{ id: "s1", label: "1", description: "", dependencies: [] },
		]);

		mgr.skipStep("s1", "不需要了");
		expect(mgr.getStep("s1")?.status).toBe(WorkflowStepStatus.SKIPPED);
		expect(mgr.getStep("s1")?.result).toContain("不需要了");
	});

	it("should report isComplete when all steps are done", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("测试", [
			{ id: "s1", label: "1", description: "", dependencies: [] },
			{ id: "s2", label: "2", description: "", dependencies: [] },
		]);

		expect(mgr.isComplete()).toBe(false);
		mgr.completeStep("s1");
		expect(mgr.isComplete()).toBe(false);
		mgr.completeStep("s2");
		expect(mgr.isComplete()).toBe(true);
	});

	it("should not block next steps when a dependency is skipped", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("跳过依赖", [
			{ id: "a", label: "A", description: "", dependencies: [] },
			{ id: "b", label: "B", description: "", dependencies: ["a"] },
		]);

		mgr.skipStep("a");
		expect(mgr.getNextSteps()).toHaveLength(1);
		expect(mgr.getNextSteps()[0].id).toBe("b");
	});

	it("should NOT unblock next steps when a dependency is failed", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("失败依赖", [
			{ id: "a", label: "A", description: "", dependencies: [] },
			{ id: "b", label: "B", description: "", dependencies: ["a"] },
		]);

		mgr.failStep("a");
		expect(mgr.getNextSteps()).toHaveLength(0);
	});

	// ─── Context store ───

	it("should store and retrieve context", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("测试", [
			{ id: "s1", label: "1", description: "", dependencies: [] },
		]);

		mgr.setContext("key1", "value1");
		expect(mgr.getContext("key1")).toBe("value1");
		expect(mgr.getContext("nonexistent")).toBeUndefined();
	});

	it("should not store context when no plan exists", () => {
		const mgr = new WorkflowPlanManager();
		mgr.setContext("k", "v");
		expect(mgr.getContext("k")).toBeUndefined();
	});

	// ─── replaceSteps ───

	it("should replace steps with new plan", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("初始", [
			{ id: "s1", label: "1", description: "", dependencies: [] },
		]);
		mgr.startStep("s1");

		mgr.replaceSteps([
			{ id: "new1", label: "新1", description: "", dependencies: [] },
			{ id: "new2", label: "新2", description: "", dependencies: ["new1"] },
		]);

		expect(mgr.getPlan()?.steps).toHaveLength(2);
		expect(mgr.getStep("s1")).toBeUndefined();
		expect(mgr.getStep("new1")?.status).toBe(WorkflowStepStatus.PENDING);
		expect(mgr.getProgress().current).toBeNull();
		expect(mgr.getNextSteps()).toHaveLength(1);
		expect(mgr.getNextSteps()[0].id).toBe("new1");
	});

	// ─── toSystemPromptSection ───

	it("should produce valid system prompt section", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("实现登录", [
			{
				id: "db",
				label: "设计数据库",
				description: "创建用户表",
				dependencies: [],
			},
			{
				id: "api",
				label: "编写 API",
				description: "登录接口",
				dependencies: ["db"],
			},
		]);
		mgr.setContext("userId", "42");

		const prompt = mgr.toSystemPromptSection();
		expect(prompt).toContain("实现登录");
		expect(prompt).toContain("0/2");
		expect(prompt).toContain("db");
		expect(prompt).toContain("api");
		expect(prompt).toContain("userId: 42");
	});

	it("should emit step lifecycle events", () => {
		const onEvent = vi.fn();
		const mgr = new WorkflowPlanManager({ onEvent });
		mgr.initPlan("测试", [
			{ id: "s1", label: "1", description: "", dependencies: [] },
		]);

		mgr.startStep("s1");
		expect(onEvent).toHaveBeenCalledWith(
			expect.objectContaining({ type: "step_started", stepId: "s1" }),
		);

		mgr.completeStep("s1");
		expect(onEvent).toHaveBeenCalledWith(
			expect.objectContaining({ type: "step_completed", stepId: "s1" }),
		);
	});

	// ─── getNextStepHint ───

	it("should hint next step", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("测试", [
			{ id: "s1", label: "第一步", description: "", dependencies: [] },
		]);

		expect(mgr.getNextStepHint()).toContain("第一步");
		expect(mgr.getNextStepHint()).toContain("s1");

		mgr.completeStep("s1");
		expect(mgr.getNextStepHint()).toContain("已完成");
	});

	it("should hint about blocked steps when dependency failed", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("测试", [
			{ id: "a", label: "A", description: "", dependencies: [] },
			{ id: "b", label: "B", description: "", dependencies: ["a"] },
		]);

		mgr.failStep("a");
		const hint = mgr.getNextStepHint();
		expect(hint).toContain("branch_workflow");
		expect(hint).toContain("b");
	});

	// ─── clearPlan ───

	it("should clear the plan", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("测试", [
			{ id: "s1", label: "1", description: "", dependencies: [] },
		]);
		expect(mgr.getPlan()).not.toBeNull();

		mgr.clearPlan();
		expect(mgr.getPlan()).toBeNull();
		expect(mgr.getProgress()).toEqual({
			completed: 0,
			total: 0,
			current: null,
		});
	});

	// ─── updatePlan ───

	it("should update plan summary and context", () => {
		const mgr = new WorkflowPlanManager();
		mgr.initPlan("旧摘要", [
			{ id: "s1", label: "1", description: "", dependencies: [] },
		]);

		mgr.updatePlan({ summary: "新摘要", context: { extra: "data" } });
		expect(mgr.getPlan()?.summary).toBe("新摘要");
		expect(mgr.getContext("extra")).toBe("data");
	});
});
