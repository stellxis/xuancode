import { describe, expect, it } from "vitest";
import { parseMarkdownLine } from "./ast";

describe("parseMarkdownLine（共享 AST）", () => {
	it("普通行 → 无样式单段", () => {
		expect(parseMarkdownLine("普通文本")).toEqual([{ text: "普通文本" }]);
	});

	it("**bold** 解析为 bold 段", () => {
		const segs = parseMarkdownLine("前 **加粗** 后");
		expect(segs).toEqual([
			{ text: "前 " },
			{ text: "加粗", bold: true },
			{ text: " 后" },
		]);
	});

	it("`code` 解析为 indigo + dim 段", () => {
		const segs = parseMarkdownLine("运行 `npm test` 完成");
		expect(segs).toEqual([
			{ text: "运行 " },
			{ text: "npm test", dim: true, color: "indigo" },
			{ text: " 完成" },
		]);
	});

	it("~~strikethrough~~ 解析为 strikethrough 段", () => {
		const segs = parseMarkdownLine("~~废弃~~");
		expect(segs).toEqual([{ text: "废弃", strikethrough: true }]);
	});

	it("标题 # 提取内容并加 bold + gold", () => {
		expect(parseMarkdownLine("## 安装指南")).toEqual([
			{ text: "安装指南", bold: true, color: "gold" },
		]);
		expect(parseMarkdownLine("### 细节")).toEqual([
			{ text: "细节", bold: true, color: "gold" },
		]);
	});

	it("分隔线 --- / *** 转为水平线段", () => {
		const segs = parseMarkdownLine("---");
		expect(segs).toHaveLength(1);
		expect(segs[0].dim).toBe(true);
		expect(segs[0].text).toMatch(/^─+$/);
		expect(parseMarkdownLine("***")).toEqual(segs);
	});

	it("引用 > 前缀 │ 并整体 dim", () => {
		const segs = parseMarkdownLine("> 引用内容");
		expect(segs[0]).toEqual({ text: "│ ", dim: true, color: "dim" });
		expect(segs[1]).toEqual({ text: "引用内容", dim: true, color: "dim" });
	});

	it("列表 - 转为 • 前缀", () => {
		const segs = parseMarkdownLine("- 第一项");
		expect(segs[0]).toEqual({ text: "• " });
		expect(segs[1]).toEqual({ text: "第一项" });
	});

	it("数字列表保留序号", () => {
		const segs = parseMarkdownLine("3. 第三项");
		expect(segs[0]).toEqual({ text: "3. " });
		expect(segs[1]).toEqual({ text: "第三项" });
	});

	it("链接 [text](url) 提取文字并加 info + dim", () => {
		const segs = parseMarkdownLine("参见 [文档](https://example.com)");
		expect(segs).toEqual([{ text: "参见 文档", color: "info", dim: true }]);
	});

	it("空输入 → 空文本段", () => {
		expect(parseMarkdownLine("")).toEqual([{ text: "" }]);
	});

	it("无闭合代码围栏等非法标记按普通文本处理", () => {
		const segs = parseMarkdownLine("a ** 未闭合");
		expect(segs).toEqual([{ text: "a ** 未闭合" }]);
	});
});
