import type { Message } from "@xuancode/types";
import { describe, expect, it } from "vitest";
import { getSnipRatio, snipCompact } from "./snip";

function makeMsgs(n: number): Message[] {
	return Array.from({ length: n }, (_, i) => ({
		role: (i === 0 ? "system" : "user") as "system" | "user",
		content: `message ${i}`,
	}));
}

describe("snip", () => {
	it("should not modify messages within limit", () => {
		const msgs = makeMsgs(10);
		const result = snipCompact(msgs, { maxMessages: 20 });
		expect(result).toHaveLength(10);
	});

	it("should trim excess messages", () => {
		const msgs = makeMsgs(100);
		const result = snipCompact(msgs, { maxMessages: 30 });
		expect(result.length).toBeLessThanOrEqual(30);
	});

	it("should preserve system messages", () => {
		const msgs = [
			{ role: "system" as const, content: "system prompt" },
			...makeMsgs(50).slice(1),
		];
		const result = snipCompact(msgs, { maxMessages: 10 });
		expect(result[0].role).toBe("system");
		expect(result[0].content).toBe("system prompt");
	});

	it("getSnipRatio should compute correctly", () => {
		expect(getSnipRatio(100, 30)).toBeCloseTo(0.7);
		expect(getSnipRatio(100, 100)).toBe(0);
	});
});
