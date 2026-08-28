import { type AgentState, StopReason } from "@xuancode/types";
import { describe, expect, it } from "vitest";
import {
	STOP_CONDITIONS,
	checkStopConditions,
	createBudgetCheck,
} from "./stopConditions";

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

describe("stopConditions", () => {
	it("should have 8 conditions", () => {
		expect(STOP_CONDITIONS.length).toBeGreaterThanOrEqual(8);
	});

	it("should not stop normally", () => {
		const state = makeState();
		expect(checkStopConditions(state)).toBeNull();
	});

	it("should stop on max turns", () => {
		const state = makeState({ turnCount: 15, maxTurns: 15 });
		expect(checkStopConditions(state)).toBe(StopReason.MAX_TURNS);
	});

	it("should stop on abort", () => {
		const state = makeState({ stopReason: StopReason.ABORT });
		expect(checkStopConditions(state)).toBe(StopReason.ABORT);
	});

	it("should stop on context overflow", () => {
		const state = makeState({ contextBudget: 0 });
		expect(checkStopConditions(state)).toBe(StopReason.CONTEXT_OVERFLOW);
	});

	it("should stop on error threshold", () => {
		const state = makeState({ consecutiveErrors: 5 });
		expect(checkStopConditions(state)).toBe(StopReason.ERROR);
	});

	it("budget check should work", () => {
		const check = createBudgetCheck(100);
		expect(check([{ role: "user", content: "a".repeat(101) }])).toBe(true);
		expect(check([{ role: "user", content: "hello" }])).toBe(false);
	});

	it("conditions should have unique names", () => {
		const names = STOP_CONDITIONS.map((c) => c.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("should have priority ordering", () => {
		for (let i = 1; i < STOP_CONDITIONS.length; i++) {
			expect(STOP_CONDITIONS[i].priority).toBeGreaterThanOrEqual(
				STOP_CONDITIONS[i - 1].priority,
			);
		}
	});
});
