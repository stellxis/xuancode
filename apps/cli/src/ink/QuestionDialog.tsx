import { Box, Static, Text, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { colors } from "./theme";

export interface AskQuestion {
	id: number;
	question: string;
	options?: string[];
	answer?: string;
	answeredAt?: number;
}

interface QuestionDialogProps {
	questions: AskQuestion[];
	turn: number;
	progressSummary?: string;
	inputMode: "menu" | "text";
	onSelectAnswer: (answer: string) => void;
	onSelectCustom: () => void;
	onCancelCustom: () => void;
}

/** CJK 双宽判断 - 排除框线字符（终端中框线单宽） */
function isCJK(ch: string): boolean {
	const code = ch.charCodeAt(0);
	return (
		(code >= 0x4e00 && code <= 0x9fff) || // CJK 汉字
		(code >= 0x3000 && code <= 0x303f) || // CJK 符号
		(code >= 0xff00 && code <= 0xffef) || // 全角字符
		(code >= 0x1f300 && code <= 0x1f9ff) || // 表情符号
		(code >= 0x2600 && code <= 0x26ff) || // 杂项符号（✦ 等）
		code === 0x25cf
	); // ● 黑色圆点
}

function visualLen(s: string): number {
	let len = 0;
	for (const ch of s) len += isCJK(ch) ? 2 : 1;
	return len;
}

function padVisual(s: string, width: number): string {
	const cur = visualLen(s);
	const pad = Math.max(0, width - cur);
	return s + " ".repeat(pad);
}

function truncateVisual(s: string, max: number): string {
	if (visualLen(s) <= max) return s;
	let out = "";
	let len = 0;
	for (const ch of s) {
		const w = isCJK(ch) ? 2 : 1;
		if (len + w > max - 1) break;
		out += ch;
		len += w;
	}
	return `${out}…`;
}

export default function QuestionDialog({
	questions,
	turn,
	progressSummary,
	inputMode,
	onSelectAnswer,
	onSelectCustom,
	onCancelCustom,
}: QuestionDialogProps) {
	// V4 Static 重构：已答历史进 <Static>（不可变，不闪动），仅当前待答项在 live 区
	const answered = useMemo(
		() => questions.filter((q) => q.answer),
		[questions],
	);
	const pending = useMemo(() => questions.find((q) => !q.answer), [questions]);
	const [selected, setSelected] = useState(0);

	const opts = pending?.options || [];
	const itemCount = opts.length + 1; // + 「✍ 自定义回答…」

	// 切换到新待答问题时重置菜单选中项
	useEffect(() => {
		setSelected(0);
	}, [pending?.id]);

	const selectItem = useCallback(
		(idx: number) => {
			if (idx === opts.length) onSelectCustom();
			else if (opts[idx] != null) onSelectAnswer(opts[idx]);
		},
		[opts, onSelectAnswer, onSelectCustom],
	);

	useInput(
		(input, key) => {
			if (!pending) return;
			if (inputMode === "text") {
				if (key.escape) onCancelCustom();
				return;
			}
			if (key.upArrow) {
				setSelected((s) => (s - 1 + itemCount) % itemCount);
				return;
			}
			if (key.downArrow) {
				setSelected((s) => (s + 1) % itemCount);
				return;
			}
			if (key.return) {
				selectItem(selected);
				return;
			}
			const n = Number(input);
			if (Number.isInteger(n) && n >= 1 && n <= itemCount) selectItem(n - 1);
		},
		{ isActive: !!pending },
	);

	if (!pending) return null;

	const columns = process.stdout.columns || 80;
	const maxInner = Math.max(20, columns - 8);
	const maxInnerCapped = Math.min(maxInner, 96);

	// ── live 面板内容（待答问题） ──
	const header = `✦ 玄码 决策面板 · 第 ${turn} 轮${progressSummary ? ` · ${progressSummary}` : ""}${answered.length > 0 ? ` · 已答 ${answered.length} 项` : ""}`;

	const bodyLines: string[] = [];
	bodyLines.push("");
	bodyLines.push(truncateVisual(pending.question, maxInnerCapped - 2));
	bodyLines.push("");
	if (inputMode === "menu") {
		opts.forEach((opt, i) => {
			const mark = i === selected ? "▸" : " ";
			bodyLines.push(
				` ${mark} ${i + 1}) ${truncateVisual(opt, maxInnerCapped - 8)}`,
			);
		});
		bodyLines.push(
			` ${selected === opts.length ? "▸" : " "} ${opts.length + 1}) ✍ 自定义回答…`,
		);
		bodyLines.push("");
		bodyLines.push("↑/↓ 或 数字键 选择 · Enter 确认");
	} else {
		bodyLines.push("  ✍ 自定义回答…（输入后 Enter 提交 · Esc 返回菜单）");
	}

	const allLines = [header, ...bodyLines];
	const innerWidth = Math.min(
		Math.max(...allLines.map((l) => visualLen(l)), 30),
		maxInnerCapped,
	);

	const livePanel = [
		`┌─${"─".repeat(innerWidth)}─┐`,
		...allLines.map((l) => `│ ${padVisual(l, innerWidth)} │`),
		`└─${"─".repeat(innerWidth)}─┘`,
	];

	return (
		<>
			{/* V4 已答历史进 Static：不可变，等待期间不会因 live 区重渲染而闪动 */}
			<Static items={answered}>
				{(q) => {
					const optIdx = q.options?.indexOf(q.answer || "");
					const mark =
						optIdx != null && optIdx >= 0 ? `已选 ${optIdx + 1})` : "✍ 自定义";
					const qLine = `问题 ${q.id}: ${truncateVisual(q.question, maxInnerCapped - 12)}`;
					const aLine = `  ✓ ${mark} ${truncateVisual(q.answer || "", maxInnerCapped - 10)}`;
					const w = Math.min(
						Math.max(visualLen(qLine), visualLen(aLine), 30) + 4,
						maxInnerCapped,
					);
					return (
						<Box
							key={`q-${q.id}`}
							marginLeft={2}
							marginBottom={1}
							flexDirection="column"
						>
							<Text color={colors.indigo}>{`┌─${"─".repeat(w)}─┐`}</Text>
							<Text>{`│ ${padVisual(qLine, w)} │`}</Text>
							<Text color={colors.success}>{`│ ${padVisual(aLine, w)} │`}</Text>
							<Text color={colors.indigo}>{`└─${"─".repeat(w)}─┘`}</Text>
						</Box>
					);
				}}
			</Static>

			{/* live 区：仅当前待答问题，重渲染不影响上方 Static 历史 */}
			<Box marginLeft={2} marginBottom={1} flexDirection="column">
				{livePanel.map((line, i) => {
					if (i === 0 || i === livePanel.length - 1) {
						return (
							<Text key={i} color={colors.indigo}>
								{line}
							</Text>
						);
					}
					if (i === 1) {
						return (
							<Text key={i} bold color={colors.gold}>
								{line}
							</Text>
						);
					}
					return <Text key={i}>{line}</Text>;
				})}
			</Box>
		</>
	);
}
