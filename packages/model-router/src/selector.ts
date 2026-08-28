import type { ProviderRegistry } from "./registry";
import type { ProviderCapability, SelectionResult, TaskProfile } from "./types";

/**
 * Three-phase model selector:
 * 1. Profile extraction – build TaskProfile from current context
 * 2. Candidate filtering – score candidates by feature matching
 * 3. Selection – pick the best candidate with cost constraint
 */
export class ModelSelector {
	constructor(
		private registry: ProviderRegistry,
		private options: {
			/** Scoring weights (must sum to 1.0) */
			weights?: {
				toolSupport: number;
				contextWindow: number;
				costEfficiency: number;
				latency: number;
			};
			/** Maximum cost per 1K input tokens (USD) to consider */
			maxCostPer1KInput?: number;
		} = {},
	) {}

	/**
	 * Phase 1: Extract a task profile from context.
	 */
	extractProfile(params: {
		messages: number;
		estimatedTokens: number;
		hasVision: boolean;
		toolCallCount?: number;
		taskType?: TaskProfile["taskType"];
	}): TaskProfile {
		return {
			toolCallCount: params.toolCallCount ?? 0,
			contextMessages: params.messages,
			estimatedTokens: params.estimatedTokens,
			hasVisionContent: params.hasVision,
			taskType: params.taskType ?? "chat",
		};
	}

	/**
	 * Phase 2+3: Filter candidates by feature matching, score them,
	 *           and select the best one.
	 */
	select(profile: TaskProfile): SelectionResult {
		const candidates = this.registry.listCapabilities();

		if (candidates.length === 0) {
			throw new Error("No registered providers available");
		}

		const weights = this.options.weights ?? {
			toolSupport: 0.4,
			contextWindow: 0.25,
			costEfficiency: 0.2,
			latency: 0.15,
		};

		const maxCost = this.options.maxCostPer1KInput ?? 0.05;

		let best: { cap: ProviderCapability; score: number } | null = null;

		for (const cap of candidates) {
			// Skip if vision is required but not supported
			if (profile.hasVisionContent && !cap.supportsVision) continue;

			// Skip if tool calling is required but not supported
			if (profile.toolCallCount > 0 && !cap.supportsToolCalling) continue;

			// Skip if cost exceeds limit
			if (cap.costPer1KInput > maxCost) continue;

			const score = this.scoreCandidate(cap, profile, weights);

			if (!best || score > best.score) {
				best = { cap, score };
			}
		}

		if (!best) {
			// Fallback: pick cheapest available
			const fallback = candidates.sort(
				(a, b) => a.costPer1KInput - b.costPer1KInput,
			)[0];
			return {
				provider: fallback.provider,
				modelName: fallback.modelName,
				capability: fallback,
				score: 0,
				reason: "No ideal match found, fell back to cheapest",
			};
		}

		return {
			provider: best.cap.provider,
			modelName: best.cap.modelName,
			capability: best.cap,
			score: best.score,
			reason: this.buildReason(best.cap, best.score),
		};
	}

	private scoreCandidate(
		cap: ProviderCapability,
		profile: TaskProfile,
		weights: NonNullable<Required<typeof this.options>["weights"]>,
	): number {
		// Tool support score (binary)
		const toolScore = cap.supportsToolCalling
			? 1
			: profile.toolCallCount === 0
				? 1
				: 0;

		// Context window score (ratio of required to available)
		const contextScore =
			profile.estimatedTokens > 0
				? Math.min(1, cap.contextWindow / profile.estimatedTokens)
				: 1;

		// Cost efficiency (inverse of relative cost)
		const maxCost = Math.max(
			...this.registry
				.listCapabilities()
				.map((c) => c.costPer1KInput + c.costPer1KOutput),
		);
		const costScore =
			maxCost > 0
				? 1 - (cap.costPer1KInput + cap.costPer1KOutput) / maxCost
				: 1;

		// Latency score (inverse of relative latency)
		const maxLatency = Math.max(
			...this.registry.listCapabilities().map((c) => c.latencyP50),
		);
		const latencyScore = maxLatency > 0 ? 1 - cap.latencyP50 / maxLatency : 1;

		return (
			toolScore * weights.toolSupport +
			contextScore * weights.contextWindow +
			Math.max(0, costScore) * weights.costEfficiency +
			Math.max(0, latencyScore) * weights.latency
		);
	}

	private buildReason(cap: ProviderCapability, score: number): string {
		return `${cap.provider}/${cap.modelName} selected with score ${score.toFixed(3)} (ctx:${cap.contextWindow}, tools:${cap.supportsToolCalling}, cost:$${cap.costPer1KInput}/1K in)`;
	}
}
