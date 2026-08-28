import { Text } from "ink";
import React from "react";
import { colors } from "./theme";
import { THREAD } from "./threadConst";

// ===== Types =====

export interface MdSegment {
	text: string;
	bold?: boolean;
	dim?: boolean;
	color?: string;
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
				color: colors.info,
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
		return parseInline(headingMatch[2], { bold: true, color: colors.gold });
	}

	// 引用 >
	const quoteMatch = line.match(/^>\s?(.*)/);
	if (quoteMatch) {
		const segs = parseInline(quoteMatch[1]);
		segs.unshift({ text: "│ ", dim: true });
		return segs.map((s) => ({ ...s, dim: true, color: s.color || colors.dim }));
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

	// 链接 [text](url) — 提取文字，蓝色 + dim
	if (line.includes("](")) {
		const plainText = line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
		return parseInline(plainText).map((s) => ({
			...s,
			color: s.color || colors.info,
			dim: s.dim !== undefined ? s.dim : true,
		}));
	}

	// 普通行
	return parseInline(line);
}

// ===== Ink renderer =====

/**
 * 将分段数组渲染为 Ink <Text> 可用的 children
 */
export function renderSegments(segs: MdSegment[]): React.ReactNode[] {
	return segs.map((seg, i) => {
		if (seg.color && seg.bold) {
			return React.createElement(
				Text,
				{ key: i, bold: true, color: seg.color },
				seg.text,
			);
		}
		if (seg.bold) {
			return React.createElement(Text, { key: i, bold: true }, seg.text);
		}
		if (seg.color && seg.dim) {
			return React.createElement(
				Text,
				{ key: i, dimColor: true, color: seg.color },
				seg.text,
			);
		}
		if (seg.dim) {
			return React.createElement(Text, { key: i, dimColor: true }, seg.text);
		}
		if (seg.color && seg.strikethrough) {
			return React.createElement(
				Text,
				{ key: i, strikethrough: true, color: seg.color },
				seg.text,
			);
		}
		if (seg.strikethrough) {
			return React.createElement(
				Text,
				{ key: i, strikethrough: true },
				seg.text,
			);
		}
		if (seg.color) {
			return React.createElement(Text, { key: i, color: seg.color }, seg.text);
		}
		return seg.text;
	});
}

/**
 * 解析一行并直接返回渲染后的 ReactNode 数组（合成）
 */
export function renderMarkdownLineToInk(line: string): React.ReactNode[] {
	return renderSegments(parseMarkdownLine(line));
}
