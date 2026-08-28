import type { ModelAdapter } from "@xuancode/model-adapter";
import type { Message, ModelStreamEvent } from "@xuancode/types";
import { CostTracker } from "./costTracker";
import { LegacyBridgeAdapter } from "./legacyBridge";
import { PromptBuilder } from "./promptBuilder";
import { ProviderRegistry } from "./registry";
import { ModelSelector } from "./selector";
import type {
	ApiToolDefinition,
	CostRecord,
	ProviderAdapter,
	ProviderCapability,
	SelectionResult,
	TaskProfile,
} from "./types";

/**
 * ModelRouter – the main facade implementing ModelAdapter.
 *
 * Supports three modes:
 * - "auto": automatically select the best model via ModelSelector
 * - "fixed": use a specific registered provider/model
 * - "legacy": fall back to the old ModelAdapter via LegacyBridgeAdapter
 */
export class ModelRouter implements ModelAdapter {
	readonly registry = new ProviderRegistry();
	readonly selector = new ModelSelector(this.registry);
	readonly costTracker = new CostTracker();
	readonly promptBuilder = new PromptBuilder();

	private currentProvider: ProviderAdapter | null = null;
	private currentCapability: ProviderCapability | null = null;
	private fallbackAdapter: ModelAdapter | null = null;
	private mode: "auto" | "fixed" | "legacy" = "auto";
	private resolvedProvider = "";
	private resolvedModel = "";

	/** Provider name reported for ModelAdapter interface */
	get provider(): string {
		return (
			this.resolvedProvider ||
			this.currentProvider?.provider ||
			this.fallbackAdapter?.provider ||
			"none"
		);
	}
	/** Model name reported for ModelAdapter interface */
	get modelName(): string {
		return (
			this.resolvedModel ||
			this.currentProvider?.model ||
			this.fallbackAdapter?.modelName ||
			"none"
		);
	}

	/** Get current selection info */
	get current(): {
		provider: string;
		model: string;
		capability: ProviderCapability | null;
	} {
		return {
			provider: this.provider,
			model: this.modelName,
			capability: this.currentCapability,
		};
	}

	/**
	 * Set a fallback old-style ModelAdapter.
	 * Used during migration when model-router doesn't have a matching adapter.
	 */
	setFallback(adapter: ModelAdapter): void {
		this.fallbackAdapter = adapter;
		// Wrap as LegacyBridgeAdapter for registry
		const bridge = new LegacyBridgeAdapter(adapter);
		this.registry.register(
			{
				provider: adapter.provider,
				modelName: adapter.modelName,
				contextWindow: 128_000,
				supportsVision: false,
				supportsToolCalling: true,
				costPer1KInput: 0,
				costPer1KOutput: 0,
				latencyP50: 1000,
				maxOutputTokens: 4096,
			},
			bridge,
		);
	}

	/**
	 * Set a provider adapter as the current active model.
	 */
	setProvider(provider: string, modelName: string): void {
		const adapter = this.registry.getAdapter(provider, modelName);
		if (!adapter) {
			throw new Error(
				`Provider ${provider}/${modelName} not registered. ` +
					`Available: ${this.registry
						.listCapabilities()
						.map((c) => `${c.provider}/${c.modelName}`)
						.join(", ")}`,
			);
		}
		this.currentProvider = adapter;
		this.currentCapability =
			this.registry.getCapability(provider, modelName) ?? null;
		this.resolvedProvider = provider;
		this.resolvedModel = modelName;
		this.mode = "fixed";
	}

	/**
	 * Enable auto-select mode.
	 */
	setAutoMode(): void {
		this.mode = "auto";
		this.currentProvider = null;
		this.currentCapability = null;
	}

	/**
	 * Switch to legacy fallback mode.
	 */
	setLegacyMode(): void {
		this.mode = "legacy";
		this.currentProvider = null;
		this.currentCapability = null;
	}

	/** Get current mode */
	getMode(): string {
		return this.mode;
	}

	/**
	 * Select a model based on task profile.
	 * In auto mode, calls ModelSelector.
	 * In fixed mode, returns current provider.
	 */
	selectModel(profile: TaskProfile): SelectionResult {
		if (this.mode === "fixed" && this.currentProvider) {
			return {
				provider: this.currentProvider.provider,
				modelName: this.currentProvider.model,
				capability: this.currentCapability!,
				score: 1,
				reason: "Fixed mode",
			};
		}
		return this.selector.select(profile);
	}

	async chat(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): Promise<string> {
		const adapter = this.resolveAdapter(messages);
		const prompt = this.buildPrompt(systemPrompt);
		const start = Date.now();

		try {
			const result = await adapter.chat(messages, prompt, tools);
			this.recordCost(adapter, messages, result, Date.now() - start);
			return result;
		} catch (err) {
			// Retry through fallback if available
			if (this.fallbackAdapter && adapter !== this.resolveFallback()) {
				return this.fallbackAdapter.chat(messages, prompt, tools);
			}
			throw err;
		}
	}

	async *chatStream(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
	): AsyncGenerator<ModelStreamEvent, void, unknown> {
		const adapter = this.resolveAdapter(messages);
		const prompt = this.buildPrompt(systemPrompt);
		const start = Date.now();
		let fullText = "";

		try {
			for await (const token of adapter.chatStream(messages, prompt, tools)) {
				// 富结构事件：结构化工具调用直接透传，仅文本增量计入 token 统计
				if (typeof token === "string") fullText += token;
				yield token;
			}
			this.recordCost(adapter, messages, fullText, Date.now() - start);
		} catch (err) {
			// Retry through fallback if available
			if (this.fallbackAdapter && adapter !== this.resolveFallback()) {
				for await (const token of this.fallbackAdapter.chatStream(
					messages,
					prompt,
					tools,
				)) {
					yield token;
				}
			}
			throw err;
		}
	}

	private resolveAdapter(messages: Message[]): ProviderAdapter {
		// In legacy mode, always use the fallback wrapped adapter
		if (this.mode === "legacy" && this.fallbackAdapter) {
			return this.resolveFallback();
		}

		// If no current provider, auto-select
		if (!this.currentProvider) {
			const profile = this.buildProfile(messages);
			const result = this.selectModel(profile);
			const adapter = this.registry.getAdapter(
				result.provider,
				result.modelName,
			);
			if (adapter) {
				this.currentProvider = adapter;
				this.currentCapability = result.capability;
				this.resolvedProvider = result.provider;
				this.resolvedModel = result.modelName;
			}
		}

		return this.currentProvider ?? this.resolveFallback();
	}

	private resolveFallback(): ProviderAdapter {
		return this.registry.getAdapter(
			this.fallbackAdapter?.provider!,
			this.fallbackAdapter?.modelName!,
		)!;
	}

	private buildProfile(messages: Message[]): TaskProfile {
		const estimatedTokens = messages.reduce((sum, m) => {
			let tokens = m.content.length / 2;
			// Rough image token estimation: ~170 tokens per 256x256 tile
			if (m.attachments) {
				for (const att of m.attachments) {
					if (att.type === "image" && att.data) {
						const rawBytes = (att.data.length / 4) * 3;
						const sidePx = Math.sqrt(rawBytes / 3);
						const tiles = Math.max(1, Math.ceil(sidePx / 256));
						tokens += tiles * tiles * 170;
					}
				}
			}
			return sum + tokens;
		}, 0);
		return {
			toolCallCount: 0,
			contextMessages: messages.length,
			estimatedTokens: Math.round(estimatedTokens),
			hasVisionContent: messages.some(
				(m) =>
					(typeof m.content === "string" && m.content.includes("data:image")) ||
					m.attachments?.some((a) => a.type === "image"),
			),
			taskType: "chat",
		};
	}

	private buildPrompt(systemPrompt?: string): string | undefined {
		if (!systemPrompt) return undefined;
		if (!this.currentCapability) return systemPrompt;
		return this.promptBuilder.build(this.currentCapability, systemPrompt);
	}

	private recordCost(
		_adapter: ProviderAdapter,
		messages: Message[],
		result: string,
		latencyMs: number,
	): void {
		const inputTokens = Math.round(
			messages.reduce((sum, m) => sum + m.content.length / 2, 0),
		);
		const outputTokens = Math.round(result.length / 2);

		const cap = this.currentCapability;
		const cost = cap
			? (inputTokens / 1000) * cap.costPer1KInput +
				(outputTokens / 1000) * cap.costPer1KOutput
			: 0;

		this.costTracker.record({
			provider: this.provider,
			model: this.modelName,
			inputTokens,
			outputTokens,
			cost,
			latencyMs,
			timestamp: Date.now(),
		});
	}
}
