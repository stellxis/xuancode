import { describe, expect, it } from "vitest";
import { StateManager } from "./stateManager";

describe("StateManager", () => {
	it("should create with default state", () => {
		const sm = new StateManager();
		const state = sm.getState();
		expect(state.turnCount).toBe(0);
		expect(state.maxTurns).toBe(50);
		expect(state.messages).toEqual([]);
		expect(state.consecutiveErrors).toBe(0);
	});

	it("should initialize with custom values", () => {
		const sm = new StateManager({ maxTurns: 10, turnCount: 2 });
		expect(sm.getState().maxTurns).toBe(10);
		expect(sm.getState().turnCount).toBe(2);
	});

	it("should increment turn", () => {
		const sm = new StateManager();
		sm.incrementTurn();
		expect(sm.getState().turnCount).toBe(1);
	});

	it("should extend turn budget without resetting turnCount", () => {
		const sm = new StateManager({ maxTurns: 3, turnCount: 3 });
		sm.extendTurns(3);
		const state = sm.getState();
		expect(state.maxTurns).toBe(6);
		expect(state.turnCount).toBe(3); // 轮次单调递增，不复位
	});

	it("should add messages", () => {
		const sm = new StateManager();
		sm.addMessage({ role: "user", content: "hello" });
		expect(sm.getState().messages).toHaveLength(1);
		expect(sm.getState().messages[0].content).toBe("hello");
	});

	it("should snapshot and rollback", () => {
		const sm = new StateManager();
		sm.addMessage({ role: "user", content: "first" });
		sm.snapshot();
		sm.addMessage({ role: "user", content: "second" });
		expect(sm.getState().messages).toHaveLength(2);
		sm.rollback();
		expect(sm.getState().messages).toHaveLength(1);
		expect(sm.getState().messages[0].content).toBe("first");
	});

	it("should track errors", () => {
		const sm = new StateManager();
		sm.addError("test error", true);
		expect(sm.getState().errorHistory).toHaveLength(1);
		expect(sm.getState().consecutiveErrors).toBe(1);
	});

	it("should track tool calls", () => {
		const sm = new StateManager();
		sm.setLastToolCall({ type: "read_file", path: "test.ts" });
		expect(sm.getState().lastToolCall?.type).toBe("read_file");
	});

	it("should consume budget", () => {
		const sm = new StateManager({ contextBudget: 100 });
		expect(sm.consumeBudget(30)).toBe(true);
		expect(sm.getState().contextBudget).toBe(70);
		expect(sm.consumeBudget(100)).toBe(false);
	});

	it("should emit events", () => {
		const sm = new StateManager();
		let emitted = false;
		sm.on("turn", () => {
			emitted = true;
		});
		sm.incrementTurn();
		expect(emitted).toBe(true);
	});

	it("B1: compressWithSummary 在轮次≤15 时不压缩", () => {
		const sm = new StateManager({ turnCount: 10 });
		sm.addMessage({ role: "user", content: "任务目标" });
		sm.compressWithSummary("[项目状态]");
		expect(sm.getState().messages).toHaveLength(1);
	});

	it("B1: compressWithSummary 生成真实摘要并保留会话目标/文件清单/项目状态", () => {
		const sm = new StateManager({ turnCount: 20 });
		sm.addMessage({ role: "user", content: "请修复登录模块的会话保持问题" });
		for (let i = 0; i < 8; i++) {
			sm.addMessage({
				role: "assistant",
				content: `{"type":"write_file","path":"/src/login.ts","content":"..."} 第 ${i} 轮修改`,
			});
			sm.addMessage({
				role: "user",
				content: `工具结果: {"ok":true,"summary":"写入成功: /src/login.ts"} 第 ${i} 轮完成`,
			});
		}
		const before = sm.getState().messages.length;
		expect(before).toBeGreaterThan(15);

		sm.compressWithSummary(
			"[项目状态] 修复登录 bug · 改动: /src/login.ts · 计划: 步骤1完成",
		);

		const msgs = sm.getState().messages;
		const all = msgs.map((m) => m.content).join("\n");
		expect(msgs.length).toBeLessThan(before);
		expect(all).toContain("会话目标");
		expect(all).toContain("修复登录模块的会话保持问题");
		expect(all).toContain("/src/login.ts");
		expect(all).toContain("[项目状态]");
		expect(all).toContain("修复登录 bug");
	});
});
