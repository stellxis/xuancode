import type { ProviderCapability } from "./types";

/**
 * Dynamic system prompt builder based on model capabilities.
 */
export class PromptBuilder {
	/**
	 * Build a system prompt tailored to the selected model's capabilities.
	 */
	build(
		cap: ProviderCapability,
		basePrompt: string,
		options?: { extraInstructions?: string },
	): string {
		const parts: string[] = [basePrompt];

		// Add capability-specific instructions
		if (!cap.supportsToolCalling) {
			parts.push(
				"Note: This model does not support native tool calling. " +
					"When you need to use a tool, respond with a JSON block " +
					'formatted as: <tool name="tool_name">{"arg":"value"}</tool>',
			);
		}

		if (cap.contextWindow < 32_000) {
			parts.push(
				`Note: This model has a limited context window (${cap.contextWindow} tokens). Keep responses concise. Use the compression system when context approaches limits.`,
			);
		}

		if (!cap.supportsVision) {
			parts.push(
				"Note: This model cannot process images. " +
					"Describe visual content textually when needed.",
			);
		}

		if (options?.extraInstructions) {
			parts.push(options.extraInstructions);
		}

		return parts.join("\n\n");
	}
}
