import { describe, expect, it } from "vitest";
import {
	extractInvokeBlocks,
	extractJsonBlocks,
	hasToolCallArtifacts,
	parseAllToolCalls,
	parseToolCall,
	stripNativeToolJson,
	stripThinkContent,
	stripToolCalls,
} from "./toolParser";

describe("toolParser", () => {
	it("should parse JSON from fenced code block", () => {
		const text =
			'Some text\n```json\n{"type":"read_file","path":"test.ts"}\n```\nmore text';
		const result = parseToolCall(text);
		expect(result).not.toBeNull();
		expect(result?.type).toBe("read_file");
		expect(result?.path).toBe("test.ts");
	});

	it("should parse bare JSON object", () => {
		const text = '{"type":"list_dir","path":"."}';
		const result = parseToolCall(text);
		expect(result).not.toBeNull();
		expect(result?.type).toBe("list_dir");
	});

	it("should extract JSON blocks", () => {
		const text = '```\n{"a":1}\n```\n```\n{"b":2}\n```';
		const blocks = extractJsonBlocks(text);
		expect(blocks).toHaveLength(2);
	});

	it("should keep conversational text and only strip think blocks", () => {
		const text = '让我思考一下\n\n{"type":"read_file","path":"x.ts"}';
		const result = stripThinkContent(text);
		// stripThinkContent only removes <think> reasoning blocks, preserves all conversational text
		expect(result).toBe(text);
	});

	it("should strip <think> blocks (DeepSeek reasoning)", () => {
		const text =
			'让我思考\n<think>\n推理内容\n</think>\n{"type":"read_file","path":"x.ts"}';
		const result = stripThinkContent(text);
		expect(result).toBe('让我思考\n\n{"type":"read_file","path":"x.ts"}');
	});

	it("should return null for non-JSON text", () => {
		const result = parseToolCall("Hello, this is a plain response.");
		expect(result).toBeNull();
	});

	it("should parse <tool_call> tag format (DeepSeek native)", () => {
		const text =
			'我先查看目录结构\n<tool_call>\n{"type":"list_dir","path":"."}\n</tool_call>';
		const result = parseToolCall(text);
		expect(result).not.toBeNull();
		expect(result?.type).toBe("list_dir");
	});

	it("should parse multiple tool calls with parseAllToolCalls", () => {
		const text =
			'同时执行两个操作\n<tool_call>\n{"type":"list_dir","path":"."}\n</tool_call>\n<tool_call>\n{"type":"glob","pattern":"**/*.ts"}\n</tool_call>';
		const results = parseAllToolCalls(text);
		expect(results).toHaveLength(2);
		expect(results[0].type).toBe("list_dir");
		expect(results[1].type).toBe("glob");
	});

	it("should parse multiple JSON fenced tool calls", () => {
		const text =
			'```json\n{"type":"read_file","path":"a.ts"}\n```\n```json\n{"type":"read_file","path":"b.ts"}\n```';
		const results = parseAllToolCalls(text);
		expect(results).toHaveLength(2);
		expect(results[0].path).toBe("a.ts");
		expect(results[1].path).toBe("b.ts");
	});

	it("should handle mix of text and multiple <tool_call> blocks", () => {
		const text = `我来同时查看目录和搜索文件。

<tool_call>
{"type":"list_dir","path":"."}
</tool_call>

<tool_call>
{"type":"grep","pattern":"export function","path":"src"}
</tool_call>

完成后我会总结结果。`;
		const results = parseAllToolCalls(text);
		expect(results).toHaveLength(2);
		expect(results[0].type).toBe("list_dir");
		expect(results[1].type).toBe("grep");
	});

	// ===== XML <invoke> format tests =====

	it("should parse single XML invoke block", () => {
		const text =
			'<invoke name="read_file">\n<parameter name="path">package.json</parameter>\n</invoke>';
		const results = parseAllToolCalls(text);
		expect(results).toHaveLength(1);
		expect(results[0].type).toBe("read_file");
		expect(results[0].path).toBe("package.json");
	});

	it("should parse multiple XML invoke blocks", () => {
		const text = `<invoke name="git_status">
  <parameter name="command" string="true">git status</parameter>
</invoke>
<invoke name="list_dir">
  <parameter name="path">.</parameter>
</invoke>`;
		const results = parseAllToolCalls(text);
		expect(results).toHaveLength(2);
		expect(results[0].type).toBe("git_status");
		expect(results[1].type).toBe("list_dir");
		expect(results[1].path).toBe(".");
	});

	it("should parse mixed conversational text with XML invoke", () => {
		const text = `我来同时查看目录和搜索文件。

<invoke name="list_dir">
<parameter name="path">.</parameter>
</invoke>

<invoke name="grep">
<parameter name="pattern" string="true">export function</parameter>
<parameter name="path">src</parameter>
</invoke>

完成后我会总结结果。`;
		const results = parseAllToolCalls(text);
		expect(results).toHaveLength(2);
		expect(results[0].type).toBe("list_dir");
		expect(results[1].type).toBe("grep");
		expect(results[1].pattern).toBe("export function");
	});

	it("should extractInvokeBlocks correctly", () => {
		const text = `<invoke name="shell">
  <parameter name="command">npm test</parameter>
</invoke>`;
		const results = extractInvokeBlocks(text);
		expect(results).toHaveLength(1);
		expect(results[0].type).toBe("shell");
		expect(results[0].command).toBe("npm test");
	});

	// ===== DSML full-width-pipe format tests (GLM/ZhipuAI hallucinated tags) =====

	it("should parse DSML-wrapped <invoke> blocks (full-width pipe ｜)", () => {
		// Reproduces the exact format reported by desktop users: model emits
		// <｜｜DSML｜｜tool_call> instead of <tool_call>, with nested XML invoke.
		const text = `首先确认一下：我正在查看项目结构。

<｜｜DSML｜｜tool_call>
<｜｜DSML｜｜invoke name="list_dir">
<｜｜DSML｜｜parameter name="path" string="true">.</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_call>`;
		const results = parseAllToolCalls(text);
		expect(results).toHaveLength(1);
		expect(results[0].type).toBe("list_dir");
		expect(results[0].path).toBe(".");
	});

	it("should strip DSML tags from final user-facing text", () => {
		const text = `首先确认一下：我正在查看项目结构。

<｜｜DSML｜｜tool_call>
<｜｜DSML｜｜invoke name="list_dir">
<｜｜DSML｜｜parameter name="path" string="true">.</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_call>`;
		const stripped = stripToolCalls(text);
		// DSML wrappers must not leak into the final answer
		expect(stripped).not.toContain("DSML");
		expect(stripped).not.toContain("｜");
		expect(stripped).toContain("首先确认一下");
	});

	// ===== Plural <tool_calls> + nested XML (model hallucinated format) =====

	it("should parse <tool_calls> (plural) wrapping JSON", () => {
		const text = '<tool_calls>\n{"type":"list_dir","path":"."}\n</tool_calls>';
		const result = parseToolCall(text);
		expect(result).not.toBeNull();
		expect(result?.type).toBe("list_dir");
	});

	it("should parse <tool_calls> wrapping nested <invoke> XML", () => {
		const text = `<tool_calls> <invoke name="list_dir"> <parameter name="path">.</parameter> </invoke> </tool_calls>`;
		const results = parseAllToolCalls(text);
		expect(results).toHaveLength(1);
		expect(results[0].type).toBe("list_dir");
		expect(results[0].path).toBe(".");
	});

	it("should detect tool-call artifacts in garbled model output", () => {
		expect(hasToolCallArtifacts('<tool_calls> <invoke name="grep">...')).toBe(
			true,
		);
		expect(
			hasToolCallArtifacts(
				'<｜｜DSML｜｜tool_call><｜｜DSML｜｜invoke name="read_file">',
			),
		).toBe(true);
		expect(hasToolCallArtifacts("普通的纯文本回复，没有工具调用标签")).toBe(
			false,
		);
	});

	it("should strip bare <tool_call fragments (no closing >) from final text", () => {
		// DeepSeek V4 Flash 幻觉：正文中输出不完整的 <tool_call（无 >），
		// 此前规则都要 > 剥不掉 → 泄漏到面板。回归钉死。
		const text =
			"我先了解项目。<tool_call文件内容。<tool_callggrep 覆盖成功，找到了匹配。</tool_call";
		const stripped = stripToolCalls(text);
		expect(stripped).not.toContain("<tool_call");
		expect(stripped).not.toContain("</tool_call");
		expect(stripped).toContain("我先了解项目");
		expect(stripped).toContain("文件内容");
		expect(stripped).toContain("grep");
	});

	it("should strip plural <tool_calls> and <parameter> blocks from final text", () => {
		const text = `我正在查找。

<tool_calls> <invoke name="grep"> <parameter name="pattern">SkillData</parameter> <parameter name="path">src</parameter> </invoke> </tool_calls>

完成后我会总结。`;
		const stripped = stripToolCalls(text);
		expect(stripped).not.toContain("tool_calls");
		expect(stripped).not.toContain("<invoke");
		expect(stripped).not.toContain("<parameter");
		expect(stripped).toContain("我正在查找");
		expect(stripped).toContain("完成后我会总结");
	});

	// ===== C3-M2 原生工具 JSON 展示剔除 =====

	it("should strip injected native tool JSON lines (id: call_*) from display text", () => {
		const text =
			'我先查看目录。{"path":".","type":"list_dir","id":"call_00_abc"}';
		const stripped = stripNativeToolJson(text);
		expect(stripped).toBe("我先查看目录。");
	});

	it("should keep non-native JSON (no call_ id) untouched", () => {
		const text = '{"path":".","type":"list_dir"}';
		expect(stripNativeToolJson(text)).toBe(text);
	});

	it("should strip native JSON even when nested args contain braces (write_file content)", () => {
		const json = JSON.stringify({
			path: "x.ts",
			content: "function f() { return 1; }",
			type: "write_file",
			id: "call_00_w",
		});
		const stripped = stripNativeToolJson(`写入文件。${json}`);
		expect(stripped).toBe("写入文件。");
	});

	it("should keep invalid (unescaped) JSON — only strip valid parsed tool calls", () => {
		const text =
			'{"command":"cat x || echo "(bad)"","type":"shell","id":"call_00_bad"}';
		expect(stripNativeToolJson(text)).toBe(text);
	});
});
