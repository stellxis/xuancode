import { CompactLevel, type Message } from "@xuancode/types";
import type { MemoryItem, MemoryRankOptions } from "@xuancode/types";
import { buildCompactedMessages, generateCompactSummary } from "./autocompact";
import type { AutoCompactOptions, CompactSummary } from "./autocompact";
import { CollapsedView, contextCollapse } from "./collapse";
import type { CollapseOptions } from "./collapse";
import { MemoryManager } from "./memoryManager";
import type { MemoryLayer } from "./memoryManager";
import {
	inferTags,
	jaccardSimilarity,
	keywordOverlapScore,
	scoreItems,
	tagMatchScore,
	tokenize,
} from "./memoryRanker";
import { MemoryStore } from "./memoryStore";
import { microCompact } from "./microcompact";
import type { MicroCompactOptions } from "./microcompact";
import { snipCompact, stripOldImages } from "./snip";
import type { SnipOptions } from "./snip";
export type { ScoredItem } from "./memoryRanker";
import { CACHE_BOUNDARY, CacheBoundaryManager } from "./cacheBoundary";
import type { CacheBreakVector } from "./cacheBoundary";

/**
 * Full compaction pipeline — applies levels progressively
 *
 * Claude Code architecture uses graduated lazy-degradation:
 * - Only applies higher levels when lower levels are insufficient
 * - Each level is more expensive but more effective
 */
export function compactMessages(
	messages: Message[],
	level: CompactLevel,
	options?: any,
): Message[] {
	let result = [...messages];

	if (level >= CompactLevel.SNIP) {
		result = snipCompact(result, options as SnipOptions);
	}
	if (level >= CompactLevel.MICRO_COMPACT) {
		result = microCompact(result, options as MicroCompactOptions);
	}
	if (level >= CompactLevel.CONTEXT_COLLAPSE) {
		result = contextCollapse(
			result,
			(options as CollapseOptions)?.maxTotalChars,
		);
	}
	// Level 4 (AUTO_COMPACT) requires summary generation
	// This would be used as a last resort

	return result;
}

/**
 * Estimate token count from character length (rough heuristic)
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Estimate token count for a message, including attachments.
 * Images are estimated at ~170 tokens per 256x256 tile (OpenAI convention).
 */
export function estimateMessageTokens(msg: Message): number {
	let tokens = msg.content.length / 4;
	if (msg.attachments) {
		for (const att of msg.attachments) {
			if ((att.type === "image" || att.type === "screenshot") && att.data) {
				const rawBytes = (att.data.length / 4) * 3;
				const sidePx = Math.sqrt(rawBytes / 3);
				const tiles = Math.max(1, Math.ceil(sidePx / 256));
				tokens += tiles * tiles * 170;
			}
		}
	}
	return Math.ceil(tokens);
}

export {
	// Level 1
	snipCompact,
	stripOldImages,
	// Level 2
	microCompact,
	// Level 3
	contextCollapse,
	CollapsedView,
	// Level 4
	generateCompactSummary,
	buildCompactedMessages,
	// Memory
	MemoryManager,
	MemoryStore,
	// Memory ranker
	scoreItems,
	jaccardSimilarity,
	keywordOverlapScore,
	tagMatchScore,
	inferTags,
	tokenize,
	// Cache
	CacheBoundaryManager,
	CACHE_BOUNDARY,
};

export type {
	SnipOptions,
	MicroCompactOptions,
	CollapseOptions,
	AutoCompactOptions,
	CompactSummary,
	MemoryLayer,
	MemoryItem,
	MemoryRankOptions,
	CacheBreakVector,
};
