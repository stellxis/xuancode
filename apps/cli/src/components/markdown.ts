/**
 * Chalk Markdown 渲染后端（ANSI 字符串）
 * 解析逻辑在 markdown/ast.ts（共享 AST），此处只做 token → ANSI 映射
 */

import {
	type MdColorToken,
	type MdSegment,
	parseMarkdownLine,
} from "../markdown/ast";
import { ansi } from "../theme/colors";

/** 语义色 token → ANSI 色码（dim 无独立色码，仅靠 dim 属性） */
const ANSI_COLORS: Partial<Record<MdColorToken, string>> = {
	gold: ansi.gold,
	indigo: ansi.indigo,
	info: ansi.indigo,
};

/** 给一个分段包裹 ANSI 样式 */
function wrap(seg: MdSegment): string {
	let prefix = "";
	const suffix = ansi.reset;

	if (seg.bold) prefix += ansi.bold;
	if (seg.dim) prefix += ansi.dim;
	if (seg.strikethrough) prefix += ansi.strikethrough;
	if (seg.color) prefix += ANSI_COLORS[seg.color] ?? "";

	if (!prefix) return seg.text;
	return `${prefix}${seg.text}${suffix}`;
}

/** 渲染代码块行（带 2 空格缩进 + 银灰色） */
function renderCodeBlockLine(line: string): string {
	return `${ansi.silver}  ${line}${ansi.reset}`;
}

/**
 * 渲染一行 Markdown 文本为 ANSI 字符串
 */
export function renderMarkdownLineToChalk(line: string): string {
	return parseMarkdownLine(line).map(wrap).join("");
}

/**
 * 渲染完整多行 Markdown 文本为 ANSI 字符串。
 * 支持代码块等跨行结构。
 */
export function renderMarkdownToChalk(text: string): string {
	const lines = text.split("\n");
	const result: string[] = [];
	let inCodeBlock = false;
	let codeLines: string[] = [];

	for (const line of lines) {
		if (/^```/.test(line.trim())) {
			if (inCodeBlock) {
				// 结束代码块
				if (codeLines.length > 0) {
					result.push(codeLines.map(renderCodeBlockLine).join("\n"));
					codeLines = [];
				}
				inCodeBlock = false;
			} else {
				// 开始代码块
				inCodeBlock = true;
			}
			continue;
		}

		if (inCodeBlock) {
			codeLines.push(line);
		} else {
			result.push(renderMarkdownLineToChalk(line));
		}
	}

	// 文件末尾未闭合的代码块
	if (inCodeBlock && codeLines.length > 0) {
		result.push(codeLines.map(renderCodeBlockLine).join("\n"));
	}

	return result.join("\n");
}
