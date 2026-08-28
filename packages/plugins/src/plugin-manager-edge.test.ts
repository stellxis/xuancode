import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHookBridge } from "./hookBridge";
import { PluginRegistry } from "./index";
import { PluginManager } from "./pluginManager";

describe("PluginManager edge cases", () => {
	let pluginDir: string;
	let configDir: string;

	beforeEach(() => {
		pluginDir = path.join(tmpdir(), `pm-plugins-${randomUUID()}`);
		configDir = path.join(tmpdir(), `pm-config-${randomUUID()}`);
		fs.mkdirSync(pluginDir, { recursive: true });
		fs.mkdirSync(configDir, { recursive: true });
	});

	afterEach(() => {
		try {
			fs.rmSync(pluginDir, { recursive: true });
		} catch {
			/* ok */
		}
		try {
			fs.rmSync(configDir, { recursive: true });
		} catch {
			/* ok */
		}
	});

	it("should initialize with empty state", () => {
		const registry = new PluginRegistry();
		const pm = new PluginManager(registry, { pluginDirs: [pluginDir] });
		expect(pm.getStats().total).toBe(0);
	});

	it("should handle empty plugin directories", async () => {
		const registry = new PluginRegistry();
		const pm = new PluginManager(registry, { pluginDirs: [pluginDir] });
		await pm.initialize();
		expect(pm.getStats().total).toBe(0);
	});

	it("should create hook bridge that handles missing plugins", () => {
		const registry = new PluginRegistry();
		const hookCb = createHookBridge(registry);
		// Should not throw when no plugins are registered
		const result = hookCb("SessionStart", { sessionId: "test" });
		expect(result).toBeUndefined();
	});

	it("should get hook callback even without initialization", () => {
		const registry = new PluginRegistry();
		const pm = new PluginManager(registry, { pluginDirs: [pluginDir] });
		const cb = pm.getHookCallback();
		expect(typeof cb).toBe("function");
		// Calling it should not throw
		expect(() => cb("SessionStart", {})).not.toThrow();
	});

	it("should handle loadPlugin with non-existent path", async () => {
		const registry = new PluginRegistry();
		const pm = new PluginManager(registry, { pluginDirs: [pluginDir] });
		await expect(
			pm.loadPlugin("/non/existent/path/plugin.js"),
		).rejects.toThrow();
	});

	it("should report stats after operations", () => {
		const registry = new PluginRegistry();
		const pm = new PluginManager(registry, { pluginDirs: [pluginDir] });

		const stats = pm.getStats();
		expect(stats).toHaveProperty("total");
		expect(stats).toHaveProperty("loaded");
		expect(stats).toHaveProperty("byElement");
		expect(stats.total).toBe(0);
		expect(stats.loaded).toBe(0);
	});

	it("should handle hook events for all types", () => {
		const events = [
			"SessionStart",
			"SessionEnd",
			"PreToolUse",
			"PostToolUse",
			"PostToolUseFailure",
			"SubagentStart",
			"SubagentStop",
			"PreCompact",
			"PostCompact",
			"PermissionRequest",
			"PermissionDenied",
		];

		const registry = new PluginRegistry();
		const hookCb = createHookBridge(registry);

		for (const event of events) {
			expect(() => hookCb(event, {})).not.toThrow();
		}
	});

	it("should ignore unknown hook events", () => {
		const registry = new PluginRegistry();
		const hookCb = createHookBridge(registry);
		expect(() => hookCb("UnknownEvent" as any, {})).not.toThrow();
	});
});
