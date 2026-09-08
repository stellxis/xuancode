/**
 * 终端文本宽度工具与对话摘要 — App.tsx 拆出的纯函数
 */

import type { Message } from "@xuancode/types";

/** CJK 双宽字符判断 + 框线字符 + 表情符号 + 特殊符号 */
export function isCJK(ch: string): boolean {
	const code = ch.charCodeAt(0);
	return (
		(code >= 0x4e00 && code <= 0x9fff) || // CJK 汉字
		(code >= 0x3000 && code <= 0x303f) || // CJK 符号
		(code >= 0xff00 && code <= 0xffef) || // 全角字符
		(code >= 0x2500 && code <= 0x257f) || // 框线字符 ▐│├┤等
		(code >= 0x1f300 && code <= 0x1f9ff) || // 表情符号
		(code >= 0x2600 && code <= 0x26ff) || // 杂项符号
		code === 0x25cf
	); // ● 黑色圆点
}

/** 计算终端视觉宽度（CJK=2, ASCII=1） */
export function visualLen(s: string): number {
	let len = 0;
	for (const ch of s) len += isCJK(ch) ? 2 : 1;
	return len;
}

/** 按视觉宽度换行 */
export function wrapVisual(text: string, maxVisual: number): string[] {
	if (maxVisual <= 0 || visualLen(text) <= maxVisual) return [text];
	const lines: string[] = [];
	let start = 0;
	while (start < text.length) {
		let visual = 0;
		let end = start;
		while (end < text.length) {
			const next = visual + (isCJK(text[end]) ? 2 : 1);
			if (next > maxVisual) break;
			visual = next;
			end++;
		}
		if (end === start) end = start + 1;
		lines.push(text.slice(start, end));
		start = end;
	}
	return lines;
}

/** 将 Message[] 转成文本摘要（用于跨轮对话上下文，避免原始 Message[] 干扰停止条件） */
export function buildConversationSummary(messages: Message[]): string {
	if (messages.length === 0) return "";
	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user" && !msg.content.startsWith("工具结果:")) {
			const truncated =
				msg.content.length > 500
					? `${msg.content.slice(0, 500)}…`
					: msg.content;
			parts.push(`用户: ${truncated}`);
		} else if (msg.role === "assistant") {
			const truncated =
				msg.content.length > 1000
					? `${msg.content.slice(0, 1000)}…`
					: msg.content;
			parts.push(`玄码: ${truncated}`);
		}
	}
	return parts.join("\n").slice(0, 4000);
}
