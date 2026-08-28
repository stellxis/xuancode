import { beforeEach, describe, expect, it } from "vitest";
import { PluginRegistry, createPlugin } from "./index";
import type { PluginAPI, PluginContext, PluginManifest } from "./index";

describe("PluginRegistry", () => {
	let registry: PluginRegistry;

	beforeEach(() => {
		registry = new PluginRegistry();
	});

	it("should register a plugin", async () => {
		const plugin = createPlugin(
			{
				name: "test-plugin",
				version: "1.0.0",
				description: "A test plugin",
				element: "wood",
				events: ["onLoad"],
			},
			async () => {},
		);
		await registry.register(plugin);
		expect(registry.count).toBe(1);
	});

	it("should register and list plugins", async () => {
		const plugin = createPlugin(
			{
				name: "test-plugin",
				version: "1.0.0",
				description: "A test plugin",
				element: "water",
				events: ["onLoad", "onSessionStart"],
			},
			async () => {},
		);
		await registry.register(plugin);
		const list = registry.listPlugins();
		expect(list).toHaveLength(1);
		expect(list[0].element).toBe("water");
		expect(list[0]).toMatchObject({
			name: "test-plugin",
			version: "1.0.0",
			description: "A test plugin",
		});
	});

	it("should reject duplicate plugins", async () => {
		const plugin = createPlugin(
			{
				name: "duplicate",
				version: "1.0.0",
				description: "",
				element: "fire",
				events: [],
			},
			async () => {},
		);
		await registry.register(plugin);
		await expect(registry.register(plugin)).rejects.toThrow(/已注册/);
	});

	it("should unregister a plugin", async () => {
		const plugin = createPlugin(
			{
				name: "temp",
				version: "1.0.0",
				description: "",
				element: "earth",
				events: [],
			},
			async () => {},
		);
		await registry.register(plugin);
		expect(registry.count).toBe(1);
		await registry.unregister("temp");
		expect(registry.count).toBe(0);
	});

	it("should call init on registration", async () => {
		let inited = false;
		const plugin = createPlugin(
			{
				name: "init-test",
				version: "1.0.0",
				description: "",
				element: "metal",
				events: [],
			},
			async () => {
				inited = true;
			},
		);
		await registry.register(plugin);
		expect(inited).toBe(true);
	});

	it("should call destroy on unregistration", async () => {
		let destroyed = false;
		const plugin = createPlugin(
			{
				name: "destroy-test",
				version: "1.0.0",
				description: "",
				element: "fire",
				events: [],
			},
			async () => {},
			{
				destroy: async () => {
					destroyed = true;
				},
			},
		);
		await registry.register(plugin);
		await registry.unregister("destroy-test");
		expect(destroyed).toBe(true);
	});

	it("should run ctx.onUnload disposers on unregistration", async () => {
		let cleaned = false;
		const plugin = createPlugin(
			{
				name: "disposer-test",
				version: "1.0.0",
				description: "",
				element: "water",
				events: [],
			},
			async (ctx: PluginContext) => {
				ctx.onUnload?.(() => {
					cleaned = true;
				});
			},
		);
		await registry.register(plugin);
		expect(cleaned).toBe(false);
		await registry.unregister("disposer-test");
		expect(cleaned).toBe(true);
	});

	it("should run multiple disposers in reverse registration order", async () => {
		const order: string[] = [];
		const plugin = createPlugin(
			{
				name: "order-test",
				version: "1.0.0",
				description: "",
				element: "earth",
				events: [],
			},
			async (ctx: PluginContext) => {
				ctx.onUnload?.(() => order.push("first"));
				ctx.onUnload?.(() => order.push("second"));
			},
		);
		await registry.register(plugin);
		await registry.unregister("order-test");
		expect(order).toEqual(["second", "first"]);
	});

	it("should emit onUnload event to subscribed plugins on unregistration", async () => {
		let unloaded = false;
		const plugin = createPlugin(
			{
				name: "unload-event-test",
				version: "1.0.0",
				description: "",
				element: "wood",
				events: ["onUnload"],
			},
			async () => {},
			{
				onUnload: async () => {
					unloaded = true;
				},
			},
		);
		await registry.register(plugin);
		await registry.unregister("unload-event-test");
		expect(unloaded).toBe(true);
	});

	it("should list plugins by element", async () => {
		const plugins = [
			createPlugin(
				{
					name: "fs-plugin",
					version: "1.0.0",
					description: "",
					element: "metal",
					events: [],
				},
				async () => {},
			),
			createPlugin(
				{
					name: "code-plugin",
					version: "1.0.0",
					description: "",
					element: "wood",
					events: [],
				},
				async () => {},
			),
			createPlugin(
				{
					name: "net-plugin",
					version: "1.0.0",
					description: "",
					element: "water",
					events: [],
				},
				async () => {},
			),
		];
		for (const p of plugins) await registry.register(p);

		const byElement = registry.listByElement();
		expect(byElement.metal).toHaveLength(1);
		expect(byElement.wood).toHaveLength(1);
		expect(byElement.water).toHaveLength(1);
		expect(byElement.fire).toHaveLength(0);
		expect(byElement.earth).toHaveLength(0);
	});

	it("should emit events to subscribed plugins", async () => {
		let callCount = 0;
		const plugin = createPlugin(
			{
				name: "event-test",
				version: "1.0.0",
				description: "",
				element: "water",
				events: ["onToolCall"],
			},
			async () => {},
			{
				onToolCall: async () => {
					callCount++;
				},
			},
		);
		await registry.register(plugin);
		await registry.emitEvent("onToolCall", { type: "read_file", args: {} });
		expect(callCount).toBe(1);
	});

	it("should not emit to unsubscribed plugins", async () => {
		let callCount = 0;
		const plugin = createPlugin(
			{
				name: "no-events",
				version: "1.0.0",
				description: "",
				element: "earth",
				events: [],
			},
			async () => {},
			{
				onToolCall: async () => {
					callCount++;
				},
			},
		);
		await registry.register(plugin);
		await registry.emitEvent("onToolCall", { type: "read_file", args: {} });
		expect(callCount).toBe(0);
	});

	it("should provide registerTool API", async () => {
		const registeredName = "";
		const plugin = createPlugin(
			{
				name: "tool-plugin",
				version: "1.0.0",
				description: "",
				element: "fire",
				events: [],
			},
			async (_ctx: PluginContext, api: PluginAPI) => {
				api.registerTool?.("my_tool", async (args: any) => ({ result: args }));
			},
		);
		await registry.register(plugin);

		const tools = registry.getExtraTools();
		expect(tools.has("tool-plugin:my_tool")).toBe(true);
	});

	it("should handle init failures gracefully", async () => {
		const plugin = createPlugin(
			{
				name: "failing",
				version: "1.0.0",
				description: "",
				element: "fire",
				events: [],
			},
			async () => {
				throw new Error("init failed");
			},
		);
		await expect(registry.register(plugin)).rejects.toThrow("init failed");
	});
});

describe("createPlugin helper", () => {
	it("should create a valid plugin object", () => {
		const plugin = createPlugin(
			{
				name: "helper-test",
				version: "1.0.0",
				description: "Created with helper",
				element: "earth",
				events: ["onLoad"],
			},
			async () => {},
		);
		expect(plugin.manifest.name).toBe("helper-test");
		expect(plugin.manifest.element).toBe("earth");
		expect(typeof plugin.init).toBe("function");
	});

	it("should merge optional handlers", () => {
		const plugin = createPlugin(
			{
				name: "handlers",
				version: "1.0.0",
				description: "",
				element: "water",
				events: ["onSessionStart", "onError"],
			},
			async () => {},
			{
				onSessionStart: async () => {
					/* custom handler */
				},
				onError: async () => {
					/* error handler */
				},
			},
		);
		expect(typeof plugin.onSessionStart).toBe("function");
		expect(typeof plugin.onError).toBe("function");
		expect(plugin.onToolCall).toBeUndefined();
	});
});
