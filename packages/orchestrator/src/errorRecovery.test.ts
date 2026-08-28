import type { AgentState } from "@xuancode/types";
import { describe, expect, it } from "vitest";
import { ContinueSite, getRecovery, isRecoverable } from "./errorRecovery";

function makeState(overrides?: Partial<AgentState>): AgentState {
	return {
		messages: [{ role: "user", content: "test" }],
		turnCount: 1,
		maxTurns: 15,
		startTime: Date.now(),
		errorHistory: [],
		contextBudget: 100000,
		maxContextBudget: 200000,
		consecutiveErrors: 0,
		...overrides,
	};
}

describe("errorRecovery", () => {
	it("should recover from model call failure on first attempt", () => {
		const state = makeState({ consecutiveErrors: 0 });
		const recovery = getRecovery(
			ContinueSite.MODEL_CALL,
			state,
			new Error("timeout"),
		);
		expect(recovery.shouldContinue).toBe(true);
		expect(recovery.recoveryMessage).toContain("重试");
	});

	it("should stop after 3 consecutive model failures", () => {
		const state = makeState({ consecutiveErrors: 2 });
		const recovery = getRecovery(
			ContinueSite.MODEL_CALL,
			state,
			new Error("timeout"),
		);
		expect(recovery.shouldContinue).toBe(false);
		expect(recovery.stopReason).toBe("error");
	});

	it("should continue on empty response within retry budget", () => {
		const state = makeState({ consecutiveErrors: 2 });
		const recovery = getRecovery(ContinueSite.EMPTY_RESPONSE, state, "empty");
		expect(recovery.shouldContinue).toBe(true);
		expect(recovery.recoveryMessage).toContain("直接输出对用户有用的回答");
	});

	it("should stop after 3 consecutive empty responses", () => {
		const state = makeState({ consecutiveErrors: 3 });
		const recovery = getRecovery(ContinueSite.EMPTY_RESPONSE, state, "empty");
		expect(recovery.shouldContinue).toBe(false);
		expect(recovery.stopReason).toBe("error");
	});

	it("should handle tool execution errors gracefully", () => {
		const state = makeState({ consecutiveErrors: 0 });
		const recovery = getRecovery(
			ContinueSite.TOOL_EXECUTION,
			state,
			new Error("permission denied"),
		);
		expect(recovery.shouldContinue).toBe(true);
		expect(recovery.recoveryMessage).toContain("工具执行异常");
	});

	it("should stop after too many tool errors", () => {
		const state = makeState({ consecutiveErrors: 2 });
		const recovery = getRecovery(
			ContinueSite.TOOL_EXECUTION,
			state,
			new Error("error"),
		);
		expect(recovery.shouldContinue).toBe(false);
		expect(recovery.stopReason).toBe("error");
	});

	it("should continue on tool error (non-fatal)", () => {
		const state = makeState({ consecutiveErrors: 0 });
		const recovery = getRecovery(ContinueSite.TOOL_ERROR, state, "not found");
		expect(recovery.shouldContinue).toBe(true);
	});

	it("isRecoverable should work", () => {
		const state = makeState({ consecutiveErrors: 0 });
		expect(isRecoverable(ContinueSite.COMPACT_FAILURE, state)).toBe(true);
		expect(isRecoverable(ContinueSite.PERMISSION_HUNG, state)).toBe(false);
	});

	it("should handle all 7 continue sites", () => {
		const state = makeState();
		const sites = Object.values(ContinueSite);
		for (const site of sites) {
			const recovery = getRecovery(site, state, new Error("test"));
			expect(recovery).toBeDefined();
			expect(typeof recovery.shouldContinue).toBe("boolean");
		}
	});
});
