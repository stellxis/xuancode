import { HookEvent } from "@xuancode/types";
import { describe, expect, it } from "vitest";
import { HookRegistry, createDefaultHooks } from "./hookSystem";

describe("HookRegistry", () => {
	it("should register and execute default hooks", async () => {
		const registry = new HookRegistry();
		for (const hook of createDefaultHooks()) {
			registry.register(hook);
		}

		const events = registry.getRegisteredEvents();
		expect(events).toContain(HookEvent.PRE_TOOL_USE);
		expect(events).toContain(HookEvent.POST_TOOL_USE);
		expect(events).toContain(HookEvent.SESSION_START);
	});

	it("should handle unknown event gracefully", async () => {
		const registry = new HookRegistry();
		const results = await registry.execute(HookEvent.SESSION_START, {
			event: HookEvent.SESSION_START,
			timestamp: Date.now(),
		});

		expect(results).toEqual([]);
	});

	it("should execute command hooks with template variables", async () => {
		const registry = new HookRegistry();
		registry.register({
			event: HookEvent.PRE_TOOL_USE,
			name: "test-echo",
			execution: "command",
			command: "echo '{{toolType}}'",
		});

		const results = await registry.execute(HookEvent.PRE_TOOL_USE, {
			event: HookEvent.PRE_TOOL_USE,
			timestamp: Date.now(),
			toolType: "read_file",
		});

		expect(results.length).toBe(1);
		expect(results[0].handled).toBe(true);
	});

	it("should return hook history", async () => {
		const registry = new HookRegistry();
		registry.register({
			event: HookEvent.SESSION_START,
			name: "test-history",
			execution: "command",
			command: "echo 'hello'",
		});

		await registry.execute(HookEvent.SESSION_START, {
			event: HookEvent.SESSION_START,
			timestamp: Date.now(),
		});

		const history = registry.getHistory();
		expect(history.length).toBe(1);
		expect(history[0].event).toBe(HookEvent.SESSION_START);
		expect(history[0].duration).toBeGreaterThanOrEqual(0);
	});
});
