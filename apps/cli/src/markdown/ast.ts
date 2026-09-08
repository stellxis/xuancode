/**
 * Markdown AST 解析器（渲染目标无关）
 *
 * 一份解析逻辑，两个渲染后端：
 * - components/markdown.ts → chalk/ANSI 字符串（非交互/管道输出）
 * - ink/markdown.tsx       → Ink <Text> 组件（TUI）
 *
 * 颜色使用语义 token（MdColorToken），由各后端自行映射到
 * ANSI 256 色码（theme/colors.ts）或 Ink hex 色（ink/theme.ts）。
 */

import { THREAD } from "../ink/threadConst";

// ===== Types =====

export type MdColorToken = "gold" | "indigo" | "info" | "dim";

export interface MdSegment {
	text: string;
	bold?: boolean;
	dim?: boolean;
	color?: MdColorToken;
	strikethrough?: boolean;
}

// ===== Inline parser =====

/**
 * 解析行内标记 (**bold**, `code`, ~~strikethrough~~)
 */
function parseInline(
	text: string,
	baseStyle: Partial<MdSegment> = {},
): MdSegment[] {
	if (!text) return [{ text: "", ...baseStyle }];

	const parts: MdSegment[] = [];
	let lastIdx = 0;
	const pattern = /(\*\*(.+?)\*\*)|(`(.+?)`)|(~~(.+?)~~)/g;
	let match: RegExpExecArray | null;

	while (true) {
		match = pattern.exec(text);
		if (match === null) break;
		// 匹配前的普通文本
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
				color: "indigo",
				...baseStyle,
			});
		} else if (match[5]) {
			// ~~strikethrough~~
			parts.push({ text: match[6], strikethrough: true, ...baseStyle });
		}
		lastIdx = match.index + match[0].length;
	}

	// 尾部文本
	if (lastIdx < text.length) {
		parts.push({ text: text.slice(lastIdx), ...baseStyle });
	}

	return parts.length > 0 ? parts : [{ text, ...baseStyle }];
}

// ===== Line parser =====

/**
 * 将一行 Markdown 文本解析为带样式的分段数组。
 * 处理: 标题, 列表, 引用, 分隔线, **bold**, `code`, ~~strikethrough~~, [text](url)
 */
export function parseMarkdownLine(line: string): MdSegment[] {
	// 分隔线 --- / ***
	if (/^[-*_]{3,}$/.test(line.trim())) {
		return [{ text: THREAD.HLINE.repeat(50), dim: true }];
	}

	// 标题 ## / ###
	const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
	if (headingMatch) {
		return parseInline(headingMatch[2], { bold: true, color: "gold" });
	}

	// 引用 >
	const quoteMatch = line.match(/^>\s?(.*)/);
	if (quoteMatch) {
		const segs = parseInline(quoteMatch[1]);
		segs.unshift({ text: "│ ", dim: true });
		return segs.map((s) => ({
			...s,
			dim: true,
			color: s.color || "dim",
		}));
	}

	// 列表 - / *
	const listMatch = line.match(/^[-*]\s+(.+)/);
	if (listMatch) {
		const segs = parseInline(listMatch[1]);
		segs.unshift({ text: "• " });
		return segs;
	}

	// 数字列表 1. / 2.
	const numListMatch = line.match(/^(\d+)\.\s+(.+)/);
	if (numListMatch) {
		const segs = parseInline(numListMatch[2]);
		segs.unshift({ text: `${numListMatch[1]}. ` });
		return segs;
	}

	// 链接 [text](url) — 提取文字，indigo + dim
	if (line.includes("](")) {
		const plainText = line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
		return parseInline(plainText).map((s) => ({
			...s,
			color: s.color || "info",
			dim: s.dim !== undefined ? s.dim : true,
		}));
	}

	// 普通行
	return parseInline(line);
}
