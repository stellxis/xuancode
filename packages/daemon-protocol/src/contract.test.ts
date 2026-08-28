import { describe, expect, it } from "vitest";
import {
	AskUserPayloadSchema,
	ErrorFatalPayloadSchema,
	ErrorPayloadSchema,
	InputReceivedPayloadSchema,
	PermissionRequestPayloadSchema,
	ProgressPayloadSchema,
	TaskResultSchema,
	TokenPayloadSchema,
	ToolCallPayloadSchema,
	TurnPayloadSchema,
	WorkflowEventSchema,
} from "./index";

/**
 * 线协议契约一致性测试
 * 以三端（daemon 发出 / CLI · VSCode · Desktop 消费）实际使用的 payload 形状为准，
 * 断言 daemon-protocol schema 均能解析，防止契约漂移。
 */

describe("WorkflowEvent 契约（daemon 发出 · 三端消费）", () => {
	it("plan_created 携带 data.steps（CLI plan.ts 消费 shape）", () => {
		const event = {
			type: "plan_created",
			planId: "plan-1",
			stepId: undefined,
			timestamp: 1700000000000,
			data: {
				summary: "3 步实施",
				steps: [
					{ id: "s1", label: "分析", description: "分析现状" },
					{ id: "s2", label: "实现", description: "编写代码" },
				],
			},
		};
		const parsed = WorkflowEventSchema.parse(event);
		expect(parsed.planId).toBe("plan-1");
		expect(parsed.data?.steps).toHaveLength(2);
		// 开放 catchall：允许未来额外字段
	});

	it("step_started / step_completed 携带 stepId + data（VSCode 消费 shape）", () => {
		for (const type of [
			"step_started",
			"step_completed",
			"step_failed",
			"step_skipped",
		]) {
			const parsed = WorkflowEventSchema.parse({
				type,
				planId: "plan-1",
				stepId: "s1",
				timestamp: 1700000000000,
				data:
					type === "step_failed"
						? { error: "boom" }
						: { label: "实现", result: "ok" },
			});
			expect(parsed.stepId).toBe("s1");
		}
	});

	it("replanned / branch_applied / plan_completed 均被 type union 接受", () => {
		for (const type of ["replanned", "branch_applied", "plan_completed"]) {
			expect(() =>
				WorkflowEventSchema.parse({
					type,
					planId: "p",
					timestamp: 0,
					data: {},
				}),
			).not.toThrow();
		}
	});

	it("未知 type 被拒绝", () => {
		expect(() =>
			WorkflowEventSchema.parse({
				type: "step_frozen",
				planId: "p",
				timestamp: 0,
			}),
		).toThrow();
	});
});

describe("TaskResult 契约（SSE complete payload）", () => {
	it("CLI/daemon 实际使用的 complete payload shape 可解析", () => {
		const parsed = TaskResultSchema.parse({
			finalAnswer: "完成",
			turnCount: 3,
			toolCallCount: 5,
			stopReason: "no_tool_use",
			duration: 1234,
		});
		expect(parsed.stopReason).toBe("no_tool_use");
	});
});

describe("SSE 事件 payload 契约", () => {
	it("token：CLI 消费 { token, fullText }", () => {
		expect(
			TokenPayloadSchema.parse({ token: "hi", fullText: "hi there" }).token,
		).toBe("hi");
	});

	it("turn：CLI 消费 { turn }，daemon 额外发 contextUsage/message/dag* 不破坏", () => {
		const parsed = TurnPayloadSchema.parse({
			turn: 1,
			contextUsage: 0.3,
			dagStatus: "workflow_seeded",
			message: "工作流已就绪",
		});
		expect(parsed.turn).toBe(1);
	});

	it("tool_call：三端消费 { toolType, params, result }", () => {
		const parsed = ToolCallPayloadSchema.parse({
			toolType: "read_file",
			params: { path: "/a/b.ts" },
			result: { success: true, output: "content" },
		});
		expect(parsed.toolType).toBe("read_file");
		expect(parsed.result.success).toBe(true);
	});

	it("progress：Desktop 消费 { turn, summary, toolCallCount }", () => {
		const parsed = ProgressPayloadSchema.parse({
			turn: 2,
			summary: "已读 3 文件",
			toolCallCount: 4,
		});
		expect(parsed.summary).toBe("已读 3 文件");
	});

	it("ask_user / input_received：CLI/VSCode/Desktop 消费 shape", () => {
		const ask = AskUserPayloadSchema.parse({
			question: "继续?",
			options: ["是", "否"],
			correlationId: "c1",
		});
		expect(ask.options).toEqual(["是", "否"]);
		expect(InputReceivedPayloadSchema.parse({ answer: "是" }).answer).toBe(
			"是",
		);
	});

	it("permission_request：VSCode 消费 shape", () => {
		const parsed = PermissionRequestPayloadSchema.parse({
			requestId: "r1",
			toolType: "shell",
			params: { command: "ls" },
			reason: "执行命令",
			risk: { risk: "high" },
		});
		expect(parsed.requestId).toBe("r1");
	});

	it("error / error_fatal：三端消费 shape", () => {
		expect(
			ErrorPayloadSchema.parse({ message: "失败", site: "workflow" }).site,
		).toBe("workflow");
		expect(ErrorPayloadSchema.parse({ message: "失败" }).site).toBeUndefined();
		expect(ErrorFatalPayloadSchema.parse({ error: "致命错误" }).error).toBe(
			"致命错误",
		);
	});
});
