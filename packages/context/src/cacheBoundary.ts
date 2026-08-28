import type { Message } from "@xuancode/types";

/**
 * Cache Boundary Management
 *
 * Claude Code uses a SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker to split
 * the system prompt into:
 * - Static zone (above boundary): agent identity, core instructions, tool definitions
 * - Dynamic zone (below boundary): session state, current time, hook config
 *
 * This maximizes prompt caching efficiency.
 */

export const CACHE_BOUNDARY = "=== DYNAMIC CONTENT BELOW ===";

export interface CacheBreakVector {
	name: string;
	changed: boolean;
	value: string;
}

/**
 * Track what changes between turns to determine if cache is invalidated
 */
export class CacheBoundaryManager {
	private vectors: Map<string, string> = new Map();
	private turnNumber = 0;

	/**
	 * Track a cache break vector
	 */
	trackVector(name: string, value: string): boolean {
		const prev = this.vectors.get(name);
		this.vectors.set(name, value);
		const changed = prev !== value;
		if (changed) this.turnNumber++;

		return changed;
	}

	/**
	 * Build cache-optimized system prompt
	 *
	 * Static content goes above the boundary (cached).
	 * Dynamic content goes below (re-evaluated each turn).
	 */
	buildSystemPrompt(
		staticPrompt: string,
		dynamicContent: Record<string, string>,
	): string {
		const dynamicParts: string[] = [];

		for (const [key, value] of Object.entries(dynamicContent)) {
			this.trackVector(key, value);
			dynamicParts.push(`[${key}]\n${value}`);
		}

		return [
			staticPrompt.trim(),
			"",
			CACHE_BOUNDARY,
			...dynamicParts,
			`[turn]\n${this.turnNumber}`,
		].join("\n");
	}

	/**
	 * Split a prompt at the cache boundary
	 */
	static splitAtBoundary(prompt: string): { static_: string; dynamic: string } {
		const idx = prompt.indexOf(CACHE_BOUNDARY);
		if (idx === -1) return { static_: prompt, dynamic: "" };

		return {
			static_: prompt.slice(0, idx).trim(),
			dynamic: prompt.slice(idx + CACHE_BOUNDARY.length).trim(),
		};
	}

	/**
	 * Check if messages should trigger a cache refresh
	 */
	shouldRefreshCache(messages: Message[], lastMessageCount: number): boolean {
		if (messages.length !== lastMessageCount) return true;

		const lastMsg = messages[messages.length - 1];
		const prevLastMsg = null; // We'd need to store this

		return lastMsg !== undefined;
	}

	getTurnNumber(): number {
		return this.turnNumber;
	}
}
