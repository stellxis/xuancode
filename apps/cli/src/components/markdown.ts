/**
 * Chalk Markdown 行渲染器
 * 输出 ANSI 转义序列格式的字符串
 */

import { THREAD } from "../ink/threadConst";
import { ansi } from "../theme/colors";

// ===== Inline parser (same logic as Ink version) =====

interface Chunk {
	text: string;
	bold?: boolean;
	dim?: boolean;
	color?: string;
	strikethrough?: boolean;
}

function parseInline(text: string, baseStyle: Partial<Chunk> = {}): Chunk[] {
	if (!text) return [{ text: "", ...baseStyle }];
	const parts: Chunk[] = [];
	let lastIdx = 0;
	const pattern = /(\*\*(.+?)\*\*)|(`(.+?)`)|(~~(.+?)~~)/g;
	let match: RegExpExecArray | null;

	while (true) {
		match = pattern.exec(text);
		if (match === null) break;
		if (match.index > lastIdx) {
			parts.push({ text: text.slice(lastIdx, match.index), ...baseStyle });
		}
		if (match[1]) {
			// **bold**
			parts.push({ text: match[2], bold: true, ...baseStyle });
		} else if (match[3]) {
			// `code`
			parts.push({
				text: match[4],
				dim: true,
				color: ansi.indigo,
				...baseStyle,
			});
		} else if (match[5]) {
			// ~~strikethrough~~
			parts.push({ text: match[6], strikethrough: true, ...baseStyle });
		}
		lastIdx = match.index + match[0].length;
	}
	if (lastIdx < text.length) {
		parts.push({ text: text.slice(lastIdx), ...baseStyle });
	}
	return parts.length > 0 ? parts : [{ text, ...baseStyle }];
}

/** 给一段文本包裹 ANSI 样式（仅读取样式字段） */
function wrap(text: string, chunk: Partial<Chunk>): string {
	let prefix = "";
	const suffix = ansi.reset;

	if (chunk.bold) prefix += ansi.bold;
	if (chunk.dim) prefix += ansi.dim;
	if (chunk.strikethrough) prefix += ansi.strikethrough;
	if (chunk.color) prefix += chunk.color;

	if (!prefix) return text;
	return `${prefix}${text}${suffix}`;
}

/** 渲染代码块行（带 2 空格缩进 + 银灰色） */
function renderCodeBlockLine(line: string): string {
	return `${ansi.silver}  ${line}${ansi.reset}`;
}

/**
 * 渲染一行 Markdown 文本为 ANSI 字符串
 */
export function renderMarkdownLineToChalk(line: string): string {
	// Horizontal rule
	if (/^[-*_]{3,}$/.test(line.trim())) {
		return wrap(THREAD.HLINE.repeat(50), { dim: true });
	}

	// Heading
	const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
	if (headingMatch) {
		return parseInline(headingMatch[2], { bold: true, color: ansi.gold })
			.map((chunk) => wrap(chunk.text, chunk))
			.join("");
	}

	// Quote
	const quoteMatch = line.match(/^>\s?(.*)/);
	if (quoteMatch) {
		const segs = parseInline(quoteMatch[1]);
		const joined = segs
			.map((chunk) => wrap(chunk.text, { ...chunk, dim: true }))
			.join("");
		return wrap("│ ", { dim: true }) + joined;
	}

	// List
	const listMatch = line.match(/^[-*]\s+(.+)/);
	if (listMatch) {
		const segs = parseInline(listMatch[1]);
		return `• ${segs.map((chunk) => wrap(chunk.text, chunk)).join("")}`;
	}

	// Numbered list
	const numListMatch = line.match(/^(\d+)\.\s+(.+)/);
	if (numListMatch) {
		const segs = parseInline(numListMatch[2]);
		return `${numListMatch[1]}. ${segs.map((chunk) => wrap(chunk.text, chunk)).join("")}`;
	}

	// Link [text](url) — render just the text, dimmed + indigo
	if (line.includes("](")) {
		const linkText = line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
		return parseInline(linkText)
			.map((chunk) =>
				wrap(chunk.text, { ...chunk, color: ansi.indigo, dim: true }),
			)
			.join("");
	}

	// Normal line
	return parseInline(line)
		.map((chunk) => wrap(chunk.text, chunk))
		.join("");
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
