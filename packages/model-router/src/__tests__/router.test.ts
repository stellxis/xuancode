import { MockAdapter } from "@xuancode/model-adapter";
import { describe, expect, it } from "vitest";
import { DeepSeekAdapter } from "../adapters/deepseek";
import {
	CostTracker,
	ModelRouter,
	ModelSelector,
	PromptBuilder,
	ProviderRegistry,
} from "../index";
import { LegacyBridgeAdapter } from "../legacyBridge";

describe("ProviderRegistry", () => {
	it("registers and retrieves adapters", () => {
		const reg = new ProviderRegistry();
		const adapter = new DeepSeekAdapter("deepseek-v4-flash");
		reg.register(
			{
				provider: "deepseek",
				modelName: "deepseek-v4-flash",
				contextWindow: 128_000,
				supportsVision: false,
				supportsToolCalling: true,
				costPer1KInput: 0.0005,
				costPer1KOutput: 0.002,
				latencyP50: 800,
				maxOutputTokens: 4096,
			},
			adapter,
		);

		expect(reg.size).toBe(1);
		expect(reg.getAdapter("deepseek", "deepseek-v4-flash")).toBe(adapter);
		expect(
			reg.getCapability("deepseek", "deepseek-v4-flash")?.contextWindow,
		).toBe(128_000);
	});

	it("lists all capabilities", () => {
		const reg = new ProviderRegistry();
		reg.register(
			{
				provider: "a",
				modelName: "m1",
				contextWindow: 4000,
				supportsVision: false,
				supportsToolCalling: false,
				costPer1KInput: 0,
				costPer1KOutput: 0,
				latencyP50: 100,
				maxOutputTokens: 1000,
			},
			new DeepSeekAdapter("m1"),
		);
		reg.register(
			{
				provider: "b",
				modelName: "m2",
				contextWindow: 8000,
				supportsVision: true,
				supportsToolCalling: true,
				costPer1KInput: 0.001,
				costPer1KOutput: 0.002,
				latencyP50: 200,
				maxOutputTokens: 2000,
			},
			new DeepSeekAdapter("m2"),
		);

		const caps = reg.listCapabilities();
		expect(caps).toHaveLength(2);
	});

	it("unregisters adapters", () => {
		const reg = new ProviderRegistry();
		reg.register(
			{
				provider: "test",
				modelName: "m1",
				contextWindow: 4000,
				supportsVision: false,
				supportsToolCalling: false,
				costPer1KInput: 0,
				costPer1KOutput: 0,
				latencyP50: 100,
				maxOutputTokens: 1000,
			},
			new DeepSeekAdapter("m1"),
		);
		expect(reg.size).toBe(1);
		reg.unregister("test", "m1");
		expect(reg.size).toBe(0);
	});

	it("queries with predicate", () => {
		const reg = new ProviderRegistry();
		reg.register(
			{
				provider: "a",
				modelName: "vision",
				contextWindow: 8000,
				supportsVision: true,
				supportsToolCalling: true,
				costPer1KInput: 0.001,
				costPer1KOutput: 0.002,
				latencyP50: 200,
				maxOutputTokens: 2000,
			},
			new DeepSeekAdapter("vision"),
		);
		reg.register(
			{
				provider: "b",
				modelName: "text",
				contextWindow: 4000,
				supportsVision: false,
				supportsToolCalling: false,
				costPer1KInput: 0,
				costPer1KOutput: 0,
				latencyP50: 100,
				maxOutputTokens: 1000,
			},
			new DeepSeekAdapter("text"),
		);

		const visionModels = reg.query((c) => c.supportsVision);
		expect(visionModels).toHaveLength(1);
		expect(visionModels[0].modelName).toBe("vision");
	});
});

describe("ModelSelector", () => {
	it("selects the best model for a task", () => {
		const reg = new ProviderRegistry();
		reg.register(
			{
				provider: "cheap",
				modelName: "slow",
				contextWindow: 4000,
				supportsVision: false,
				supportsToolCalling: false,
				costPer1KInput: 0,
				costPer1KOutput: 0,
				latencyP50: 500,
				maxOutputTokens: 1000,
			},
			new DeepSeekAdapter("slow"),
		);
		reg.register(
			{
				provider: "best",
				modelName: "fast",
				contextWindow: 128_000,
				supportsVision: true,
				supportsToolCalling: true,
				costPer1KInput: 0.005,
				costPer1KOutput: 0.015,
				latencyP50: 200,
				maxOutputTokens: 4096,
			},
			new DeepSeekAdapter("fast"),
		);

		const selector = new ModelSelector(reg);
		const profile = selector.extractProfile({
			messages: 10,
			estimatedTokens: 2000,
			hasVision: false,
			toolCallCount: 3,
		});

		const result = selector.select(profile);
		expect(result.provider).toBe("best");
		expect(result.modelName).toBe("fast");
		expect(result.score).toBeGreaterThan(0);
	});

	it("throws when no providers are registered", () => {
		const reg = new ProviderRegistry();
		const selector = new ModelSelector(reg);
		expect(() =>
			selector.select({
				toolCallCount: 0,
				contextMessages: 1,
				estimatedTokens: 100,
				hasVisionContent: false,
				taskType: "chat",
			}),
		).toThrow("No registered providers");
	});

	it("filters out models without vision when vision is needed", () => {
		const reg = new ProviderRegistry();
		reg.register(
			{
				provider: "a",
				modelName: "no-vision",
				contextWindow: 4000,
				supportsVision: false,
				supportsToolCalling: false,
				costPer1KInput: 0,
				costPer1KOutput: 0,
				latencyP50: 100,
				maxOutputTokens: 1000,
			},
			new DeepSeekAdapter("no-vision"),
		);
		reg.register(
			{
				provider: "b",
				modelName: "has-vision",
				contextWindow: 8000,
				supportsVision: true,
				supportsToolCalling: false,
				costPer1KInput: 0.001,
				costPer1KOutput: 0.002,
				latencyP50: 200,
				maxOutputTokens: 2000,
			},
			new DeepSeekAdapter("has-vision"),
		);

		const selector = new ModelSelector(reg);
		const profile = selector.extractProfile({
			messages: 1,
			estimatedTokens: 100,
			hasVision: true,
		});

		const result = selector.select(profile);
		expect(result.modelName).toBe("has-vision");
	});
});

describe("CostTracker", () => {
	it("records and aggregates costs", () => {
		const tracker = new CostTracker();
		tracker.record({
			provider: "a",
			model: "m1",
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.001,
			latencyMs: 200,
			timestamp: 1,
		});
		tracker.record({
			provider: "a",
			model: "m1",
			inputTokens: 200,
			outputTokens: 100,
			cost: 0.002,
			latencyMs: 300,
			timestamp: 2,
		});
		tracker.record({
			provider: "b",
			model: "m2",
			inputTokens: 50,
			outputTokens: 25,
			cost: 0.0005,
			latencyMs: 100,
			timestamp: 3,
		});

		expect(tracker.totalCost).toBeCloseTo(0.0035, 6);
		expect(tracker.getAll()).toHaveLength(3);

		const aggregates = tracker.getAggregates();
		expect(aggregates).toHaveLength(2);

		const a1 = aggregates.find((a) => a.provider === "a");
		expect(a1?.totalCost).toBeCloseTo(0.003, 6);
		expect(a1?.requestCount).toBe(2);
		expect(a1?.avgLatencyMs).toBe(250);
	});

	it("resets records", () => {
		const tracker = new CostTracker();
		tracker.record({
			provider: "a",
			model: "m1",
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.001,
			latencyMs: 200,
			timestamp: 1,
		});
		expect(tracker.getAll()).toHaveLength(1);
		tracker.reset();
		expect(tracker.getAll()).toHaveLength(0);
	});
});

describe("PromptBuilder", () => {
	it("adds tool calling instructions when not supported", () => {
		const builder = new PromptBuilder();
		const cap = {
			provider: "test",
			modelName: "no-tools",
			contextWindow: 128_000,
			supportsVision: false,
			supportsToolCalling: false,
			costPer1KInput: 0,
			costPer1KOutput: 0,
			latencyP50: 100,
			maxOutputTokens: 1000,
		};
		const result = builder.build(cap, "You are a helpful assistant.");
		expect(result).toContain("does not support native tool calling");
		expect(result).toContain("You are a helpful assistant");
	});

	it("adds context window warning for small windows", () => {
		const builder = new PromptBuilder();
		const cap = {
			provider: "test",
			modelName: "small-ctx",
			contextWindow: 8000,
			supportsVision: true,
			supportsToolCalling: true,
			costPer1KInput: 0,
			costPer1KOutput: 0,
			latencyP50: 100,
			maxOutputTokens: 1000,
		};
		const result = builder.build(cap, "Base prompt.");
		expect(result).toContain("limited context window");
	});

	it("adds vision note when not supported", () => {
		const builder = new PromptBuilder();
		const cap = {
			provider: "test",
			modelName: "no-vision",
			contextWindow: 128_000,
			supportsVision: false,
			supportsToolCalling: true,
			costPer1KInput: 0,
			costPer1KOutput: 0,
			latencyP50: 100,
			maxOutputTokens: 1000,
		};
		const result = builder.build(cap, "Base.");
		expect(result).toContain("cannot process images");
	});

	it("includes extra instructions", () => {
		const builder = new PromptBuilder();
		const cap = {
			provider: "test",
			modelName: "m",
			contextWindow: 128_000,
			supportsVision: true,
			supportsToolCalling: true,
			costPer1KInput: 0,
			costPer1KOutput: 0,
			latencyP50: 100,
			maxOutputTokens: 1000,
		};
		const result = builder.build(cap, "Base.", {
			extraInstructions: "Be concise.",
		});
		expect(result).toContain("Be concise.");
	});
});

describe("LegacyBridgeAdapter", () => {
	it("wraps a legacy ModelAdapter", () => {
		const mock = new MockAdapter();
		const bridge = new LegacyBridgeAdapter(mock);
		expect(bridge.provider).toBe("mock");
		expect(bridge.model).toBe("mock-model");
		expect(bridge.getInner()).toBe(mock);
	});
});

describe("ModelRouter", () => {
	it("implements ModelAdapter interface", () => {
		const router = new ModelRouter();
		expect(typeof router.chat).toBe("function");
		expect(typeof router.chatStream).toBe("function");
		expect(typeof router.provider).toBe("string");
		expect(typeof router.modelName).toBe("string");
	});

	it("auto-selects provider when none set", () => {
		const router = new ModelRouter();
		router.registry.register(
			{
				provider: "test",
				modelName: "test-model",
				contextWindow: 128_000,
				supportsVision: true,
				supportsToolCalling: true,
				costPer1KInput: 0,
				costPer1KOutput: 0,
				latencyP50: 100,
				maxOutputTokens: 4096,
			},
			new DeepSeekAdapter("test-model"),
		);

		const result = router.selectModel({
			toolCallCount: 0,
			contextMessages: 1,
			estimatedTokens: 50,
			hasVisionContent: false,
			taskType: "chat",
		});

		expect(result.provider).toBe("test");
		expect(result.modelName).toBe("test-model");
	});

	it("supports fixed mode", () => {
		const router = new ModelRouter();
		const adapter = new DeepSeekAdapter("fixed-model");
		router.registry.register(
			{
				provider: "fixed",
				modelName: "fixed-model",
				contextWindow: 4000,
				supportsVision: false,
				supportsToolCalling: false,
				costPer1KInput: 0,
				costPer1KOutput: 0,
				latencyP50: 100,
				maxOutputTokens: 1000,
			},
			adapter,
		);
		router.setProvider("fixed", "fixed-model");
		expect(router.provider).toBe("fixed");
		expect(router.modelName).toBe("fixed-model");
	});

	it("supports auto/legacy mode switching", () => {
		const router = new ModelRouter();
		expect(router.getMode()).toBe("auto");
		router.setAutoMode();
		expect(router.getMode()).toBe("auto");
		router.setLegacyMode();
		expect(router.getMode()).toBe("legacy");
		router.setAutoMode();
		expect(router.getMode()).toBe("auto");
	});

	it("tracks costs via costTracker", () => {
		const router = new ModelRouter();
		expect(router.costTracker.totalCost).toBe(0);
		router.costTracker.record({
			provider: "test",
			model: "m",
			inputTokens: 100,
			outputTokens: 50,
			cost: 0.001,
			latencyMs: 100,
			timestamp: Date.now(),
		});
		expect(router.costTracker.totalCost).toBeCloseTo(0.001);
	});
});
