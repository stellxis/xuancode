import type { Message } from "@xuancode/types";
import { describe, expect, it } from "vitest";
import { microCompact } from "./microcompact";

describe("microCompact", () => {
	it("should compress long tool results", () => {
		const msgs: Message[] = [
			{
				role: "user",
				content: `工具结果: ${JSON.stringify({ data: "x".repeat(2000) })}`,
			},
		];
		const result = microCompact(msgs, { maxToolResultLength: 500 });
		expect(result[0].content.length).toBeLessThan(2000);
	});

	it("should not modify short messages", () => {
		const msgs: Message[] = [{ role: "user", content: "hello" }];
		const result = microCompact(msgs);
		expect(result[0].content).toBe("hello");
	});

	it("should truncate overly long messages", () => {
		const msgs: Message[] = [{ role: "user", content: "x".repeat(5000) }];
		const result = microCompact(msgs, { maxMessageLength: 1000 });
		expect(result[0].content.length).toBeLessThanOrEqual(1000 + 50); // + overhead for truncation msg
	});

	it("should compact code blocks", () => {
		const msgs: Message[] = [
			{
				role: "user",
				content: `\`\`\`\n${"line\n".repeat(50)}\`\`\``,
			},
		];
		const result = microCompact(msgs, { compressCodeBlocks: true });
		const lines = result[0].content.split("\n");
		const codeLines = lines.filter((l) => l !== "```" && !l.includes("折叠"));
		// Should have fewer code lines than original
		expect(codeLines.length).toBeLessThan(50);
	});
});
