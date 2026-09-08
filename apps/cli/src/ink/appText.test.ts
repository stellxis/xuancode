import { describe, expect, it } from "vitest";
import { buildConversationSummary, visualLen, wrapVisual } from "./appText";

describe("visualLen", () => {
	it("ASCII 计 1，CJK 计 2", () => {
		expect(visualLen("abc")).toBe(3);
		expect(visualLen("中文")).toBe(4);
		expect(visualLen("a中b文")).toBe(6);
	});

	it("框线字符与 ● 均计 2（按原实现的双宽语义）", () => {
		expect(visualLen("│")).toBe(2);
		expect(visualLen("●")).toBe(2);
	});
});

describe("wrapVisual", () => {
	it("不超宽直接原样返回", () => {
		expect(wrapVisual("hello", 10)).toEqual(["hello"]);
	});

	it("超宽按视觉宽度断行", () => {
		// "a中b" 视觉宽 1+2+1=4 → maxVisual 2 时断成 ["a中", "b"]? 不 — "a中" 宽 3 > 2
		// 精确行为：逐字符累计，超过 maxVisual 即断
		const lines = wrapVisual("a中b", 3);
		expect(lines).toEqual(["a中", "b"]);
	});

	it("CJK 不被从中间劈开（按整字符切）", () => {
		const lines = wrapVisual("中中中", 4);
		expect(lines).toEqual(["中中", "中"]);
	});

	it("maxVisual <= 0 时不换行", () => {
		expect(wrapVisual("hello", 0)).toEqual(["hello"]);
	});
});

describe("buildConversationSummary", () => {
	it("空消息 → 空字符串", () => {
		expect(buildConversationSummary([])).toBe("");
	});

	it("user/assistant 带角色前缀，工具结果被过滤", () => {
		const summary = buildConversationSummary([
			{ role: "user", content: "工具结果: {...}" } as any,
			{ role: "user", content: "问题" } as any,
			{ role: "assistant", content: "回答" } as any,
		]);
		expect(summary).toBe("用户: 问题\n玄码: 回答");
	});

	it("截断带省略号（user 500 / assistant 1000）", () => {
		const summary = buildConversationSummary([
			{ role: "user", content: "u".repeat(501) } as any,
			{ role: "assistant", content: "a".repeat(1001) } as any,
		]);
		expect(summary).toBe(
			`用户: ${"u".repeat(500)}…\n玄码: ${"a".repeat(1000)}…`,
		);
	});
});
