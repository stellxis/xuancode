import type { ProviderAdapter, ProviderCapability } from "./types";

/**
 * Provider registry – register, query, and retrieve adapters.
 * Acts as the single source of truth for available models.
 */
export class ProviderRegistry {
	private capabilities: Map<string, ProviderCapability> = new Map();
	private adapters: Map<string, ProviderAdapter> = new Map();

	/** Register a provider with its capability declaration */
	register(cap: ProviderCapability, adapter: ProviderAdapter): void {
		const key = this.key(cap.provider, cap.modelName);
		this.capabilities.set(key, cap);
		this.adapters.set(key, adapter);
	}

	/** Unregister a provider/model */
	unregister(provider: string, modelName: string): boolean {
		const key = this.key(provider, modelName);
		return this.capabilities.delete(key) && this.adapters.delete(key);
	}

	/** Get adapter for a specific provider/model */
	getAdapter(provider: string, modelName: string): ProviderAdapter | undefined {
		return this.adapters.get(this.key(provider, modelName));
	}

	/** Get capability for a specific provider/model */
	getCapability(
		provider: string,
		modelName: string,
	): ProviderCapability | undefined {
		return this.capabilities.get(this.key(provider, modelName));
	}

	/** List all registered capabilities */
	listCapabilities(): ProviderCapability[] {
		return Array.from(this.capabilities.values());
	}

	/** Query capabilities matching a predicate */
	query(predicate: (cap: ProviderCapability) => boolean): ProviderCapability[] {
		return this.listCapabilities().filter(predicate);
	}

	/** Get number of registered models */
	get size(): number {
		return this.capabilities.size;
	}

	private key(provider: string, model: string): string {
		return `${provider}::${model}`;
	}
}
