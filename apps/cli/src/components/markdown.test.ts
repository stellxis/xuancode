import { describe, expect, it } from "vitest";
import { THREAD } from "../ink/threadConst";
import { ansi } from "../theme/colors";
import { renderMarkdownLineToChalk, renderMarkdownToChalk } from "./markdown";

describe("renderMarkdownLineToChalk（chalk 后端）", () => {
	it("标题：bold + gold ANSI 码", () => {
		const out = renderMarkdownLineToChalk("## 标题");
		expect(out).toContain(ansi.bold);
		expect(out).toContain(ansi.gold);
		expect(out).toContain("标题");
	});

	it("行内代码：indigo 色码 + dim", () => {
		const out = renderMarkdownLineToChalk("运行 `npm test`");
		expect(out).toContain(ansi.indigo);
		expect(out).toContain(ansi.dim);
	});

	it("引用：dim 前缀 │", () => {
		const out = renderMarkdownLineToChalk("> 引用");
		expect(out.startsWith(ansi.dim)).toBe(true);
		expect(out).toContain("│ ");
	});

	it("分隔线：dim 水平线", () => {
		const out = renderMarkdownLineToChalk("---");
		expect(out).toBe(`${ansi.dim}${THREAD.HLINE.repeat(50)}${ansi.reset}`);
	});

	it("普通行无样式时输出原文", () => {
		expect(renderMarkdownLineToChalk("纯文本")).toBe("纯文本");
	});
});

describe("renderMarkdownToChalk（多行 + 代码块）", () => {
	it("代码块行带 2 空格缩进 + 银灰色，围栏行被移除", () => {
		const out = renderMarkdownToChalk("前文\n```js\nconst a = 1;\n```\n后文");
		expect(out).toContain("前文");
		expect(out).toContain(`${ansi.silver}  const a = 1;${ansi.reset}`);
		expect(out).not.toContain("```");
		expect(out).toContain("后文");
	});

	it("未闭合代码块到最后也渲染", () => {
		const out = renderMarkdownToChalk("```ts\nlet b = 2;");
		expect(out).toContain(`${ansi.silver}  let b = 2;${ansi.reset}`);
	});
});
