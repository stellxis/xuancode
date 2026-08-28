import type { Message } from "@xuancode/types";

/**
 * Level 1: Snip — Remove low-priority history, O(1) cost
 *
 * Strategy:
 * - Keep system messages
 * - Keep the most recent N messages (sliding window)
 * - Prioritize keeping tool results that were followed by successful tool calls
 */
export interface SnipOptions {
	maxMessages: number;
	preserveSystemMessages: boolean;
	keepLastToolResults: number;
}

const DEFAULT_OPTIONS: SnipOptions = {
	maxMessages: 60,
	preserveSystemMessages: true,
	keepLastToolResults: 5,
};

export function snipCompact(
	messages: Message[],
	options: Partial<SnipOptions> = {},
): Message[] {
	const opts = { ...DEFAULT_OPTIONS, ...options };

	if (messages.length <= opts.maxMessages) return messages;

	const systemMessages = opts.preserveSystemMessages
		? messages.filter((m) => m.role === "system")
		: [];

	// Count non-system messages to determine how many to keep
	const nonSystemCount = messages.length - systemMessages.length;
	const keepCount = opts.maxMessages - systemMessages.length;

	if (keepCount <= 0) {
		// Fallback: keep only the last N messages
		return messages.slice(-opts.maxMessages);
	}

	// Keep the most recent non-system messages
	const nonSystemMessages = messages.filter((m) => m.role !== "system");
	const sniped = nonSystemMessages.slice(-keepCount);

	return [...systemMessages, ...sniped];
}

/**
 * Calculate the snip ratio — how much was removed
 */
export function getSnipRatio(original: number, compacted: number): number {
	if (original === 0) return 0;
	return 1 - compacted / original;
}

/**
 * Strip image data from old messages to save context.
 * Only the last `keepLastN` messages with images retain their base64 data.
 * Older messages keep their text content but lose image blobs.
 */
export function stripOldImages(messages: Message[], keepLastN = 3): Message[] {
	// Collect indices of messages with images, scanning from the end
	const imageIndices: number[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (
			m.attachments?.some((a) => a.type === "image" || a.type === "screenshot")
		) {
			imageIndices.push(i);
			if (imageIndices.length >= keepLastN) break;
		}
	}
	const keepSet = new Set(imageIndices);

	return messages.map((m, i) => {
		if (keepSet.has(i)) return m;
		if (
			!m.attachments?.some((a) => a.type === "image" || a.type === "screenshot")
		)
			return m;
		// Strip image data but keep text content
		return {
			...m,
			attachments: m.attachments.filter(
				(a) => a.type !== "image" && a.type !== "screenshot",
			),
		};
	});
}
