import { Text } from "ink";
import React from "react";
import {
	type MdColorToken,
	type MdSegment,
	parseMarkdownLine,
} from "../markdown/ast";
import { colors } from "./theme";

// 语义色 token → Ink hex 色（解析逻辑在 markdown/ast.ts，此处只做映射）
const INK_COLORS: Record<MdColorToken, string> = {
	gold: colors.gold,
	indigo: colors.info,
	info: colors.info,
	dim: colors.dim,
};

/** 将 AST 语义色 token 解析为 Ink 可用的 hex 色 */
export function resolveMdColor(
	token: MdColorToken | undefined,
): string | undefined {
	return token ? INK_COLORS[token] : undefined;
}

export type { MdSegment };
export { parseMarkdownLine };

// ===== Ink renderer =====

/**
 * 将分段数组渲染为 Ink <Text> 可用的 children
 */
export function renderSegments(segs: MdSegment[]): React.ReactNode[] {
	return segs.map((seg, i) => {
		const color = resolveMdColor(seg.color);
		if (seg.bold) {
			return React.createElement(Text, { key: i, bold: true, color }, seg.text);
		}
		if (seg.dim && color) {
			return React.createElement(
				Text,
				{ key: i, dimColor: true, color },
				seg.text,
			);
		}
		if (seg.dim) {
			return React.createElement(Text, { key: i, dimColor: true }, seg.text);
		}
		if (seg.strikethrough) {
			return React.createElement(
				Text,
				{ key: i, strikethrough: true, color },
				seg.text,
			);
		}
		if (color) {
			return React.createElement(Text, { key: i, color }, seg.text);
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
