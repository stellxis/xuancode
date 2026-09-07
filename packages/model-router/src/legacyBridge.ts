import type { ModelAdapter } from "@xuancode/model-adapter";
import type { Message, ModelStreamEvent } from "@xuancode/types";
import type {
	ApiToolDefinition,
	ProviderAdapter,
	ReasoningLevel,
} from "./types";

/**
 * Wrap an old ModelAdapter instance into the new ProviderAdapter interface.
 * Used during the parasitic migration phase.
 */
export class LegacyBridgeAdapter implements ProviderAdapter {
	readonly provider: string;
	readonly model: string;

	constructor(private inner: ModelAdapter) {
		this.provider = inner.provider;
		this.model = inner.modelName;
	}

	async chat(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
		_reasoningLevel?: ReasoningLevel,
	): Promise<string> {
		return this.inner.chat(messages, systemPrompt, tools);
	}

	async *chatStream(
		messages: Message[],
		systemPrompt?: string,
		tools?: ApiToolDefinition[],
		_reasoningLevel?: ReasoningLevel,
	): AsyncGenerator<ModelStreamEvent, void, unknown> {
		yield* this.inner.chatStream(messages, systemPrompt, tools);
	}

	/** Get the wrapped inner adapter */
	getInner(): ModelAdapter {
		return this.inner;
	}
}
