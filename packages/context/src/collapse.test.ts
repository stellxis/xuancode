import type { Message } from "@xuancode/types";
import { describe, expect, it } from "vitest";
import { CollapsedView } from "./collapse";

describe("collapse", () => {
	it("should not collapse small conversations", () => {
		const msgs: Message[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		];
		const view = new CollapsedView(msgs, { maxTotalChars: 1000000 });
		expect(view.getMessages()).toHaveLength(2);
		expect(view.isCollapsed()).toBe(false);
	});

	it("should collapse large conversations", () => {
		const msgs: Message[] = [
			...Array.from({ length: 20 }, (_, i) => ({
				role: "user" as const,
				content: `query ${"x".repeat(100)} ${i}`,
			})),
			{ role: "user" as const, content: "final query" },
			{ role: "assistant" as const, content: "final response" },
		];
		const view = new CollapsedView(msgs, {
			maxTotalChars: 500,
			preserveLastNTurns: 2,
		});
		expect(view.isCollapsed()).toBe(true);
		const collapsed = view.getMessages();
		// Should include the summary + last messages
		expect(collapsed[0].role).toBe("system");
		expect(collapsed[0].content).toContain("上下文折叠");
	});

	it("should preserve original messages unchanged", () => {
		const msgs: Message[] = [
			...Array.from({ length: 30 }, (_, i) => ({
				role: "user" as const,
				content: "x".repeat(200),
			})),
		];
		const view = new CollapsedView(msgs, { maxTotalChars: 100 });
		expect(view.getOriginal()).toHaveLength(30);
		expect(view.getMessages().length).toBeLessThan(30);
	});
});
