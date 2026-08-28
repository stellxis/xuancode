import type { ToolResult } from "@xuancode/types";
import { Box, Text, useStdout } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import { parseMarkdownLine } from "./markdown";
import { colors } from "./theme";
import {
	LABEL,
	formatDuration,
	getThreadPrefixes,
	stepStatusIcon,
	toolIcon,
} from "./threadConst";

// ===== Types =====

export interface StepItem {
	id: string;
	label: string;
	description?: string;
	status: "pending" | "running" | "completed" | "failed" | "skipped";
	error?: string;
}

export interface ThreadItem {
	id: number;
	type: "tool-call";
	toolType: string;
	params: Record<string, string | undefined>;
	result: ToolResult;
	timestamp: number;
}

export interface LiveState {
	isThinking: boolean;
	turn: number;
	streamingText: string;
}

interface ConversationThreadProps {
	userInput: string;
	threadItems: ThreadItem[];
	isRunning: boolean;
	liveState: LiveState | null;
	finalAnswer: string;
	/** Workflow steps to render as step card */
	steps?: StepItem[];
	planSummary?: string;
	planTotal?: number;
}

// ===== Internal: display item model =====

type DisplayItemType =
	| "user-message"
	| "tool-call"
	| "thinking"
	| "answer"
	| "step-card";

interface DisplayItem {
	type: DisplayItemType;
	source: string | ThreadItem | LiveState | ConversationThreadProps;
}

// ===== Text wrapping =====

const WRAP_SAFETY_MAX = 80;

function isCJK(ch: string): boolean {
	const code = ch.charCodeAt(0);
	return (
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0x3000 && code <= 0x303f) ||
		(code >= 0xff00 && code <= 0xffef)
	);
}

function visualLen(s: string): number {
	let len = 0;
	for (const ch of s) len += isCJK(ch) ? 2 : 1;
	return len;
}

function useTextWrap(prefixWidth: number) {
	const { stdout } = useStdout();
	return function wrapText(text: string): string[] {
		const columns = stdout?.columns || process.stderr?.columns || 80;
		const maxVisual = Math.min(columns - prefixWidth, WRAP_SAFETY_MAX);
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
	};
}

// ===== Spinner =====

const SPINNERS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function Spinner() {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		const timer = setInterval(
			() => setFrame((f) => (f + 1) % SPINNERS.length),
			120,
		);
		return () => clearInterval(timer);
	}, []);
	return <>{SPINNERS[frame]}</>;
}

// ===== Tool call entry =====

function renderToolCallText(item: ThreadItem): { text: string; color: string } {
	const icon = toolIcon(item.toolType);
	const ok = item.result.success;
	const color = ok ? colors.success : colors.error;
	const mark = ok ? "✓" : "✗";
	const param =
		item.params.path || item.params.command || item.params.pattern || "";
	const truncated = param.length > 60 ? `${param.slice(0, 60)}...` : param;
	const duration = formatDuration(item.result.duration);
	const durStr = duration ? ` [${duration}]` : "";
	return {
		text: `${mark} ${icon} ${item.toolType} ${truncated}${durStr}`,
		color,
	};
}

// ===== Step card rendering =====

const EMPTY_STEPS: StepItem[] = [];

export function getStepIconAndColor(step: StepItem): {
	icon: string;
	color: string;
} {
	switch (step.status) {
		case "completed":
			return { icon: "☑", color: colors.success };
		case "running":
			return { icon: "◉", color: colors.indigo };
		case "failed":
			return { icon: "✕", color: colors.error };
		case "skipped":
			return { icon: "⊟", color: colors.dim };
		default:
			return { icon: "□", color: colors.dim };
	}
}

function StepCard({
	steps,
	planSummary,
	planTotal,
}: {
	steps: StepItem[];
	planSummary?: string;
	planTotal?: number;
}) {
	const completed = steps.filter((s) => s.status === "completed").length;
	const running = steps.find((s) => s.status === "running");
	const wrapText = useTextWrap(6);

	const lines: React.ReactNode[] = [];
	let key = 0;

	// Header with plan summary + progress
	const header = planSummary || "执行计划";
	const progress = planTotal ? ` (${completed}/${planTotal})` : "";
	const headerLines = wrapText(`${header}${progress}`);
	for (const hl of headerLines) {
		lines.push(
			<Text key={key++} bold color={colors.gold}>
				{`  · ${hl}`}
			</Text>,
		);
	}

	// Each step
	for (const step of steps) {
		const { icon, color } = getStepIconAndColor(step);
		const label = step.label;
		const labelLines = wrapText(label);
		for (let i = 0; i < labelLines.length; i++) {
			const prefix = i === 0 ? `${icon} ` : "   ";
			lines.push(
				<Text key={key++} color={color as any}>
					{`  │ ${prefix}${labelLines[i]}`}
				</Text>,
			);
		}
		if (step.description) {
			const descLines = wrapText(step.description);
			for (const dl of descLines) {
				lines.push(
					<Text key={key++} dimColor>
						{`  │    ${dl}`}
					</Text>,
				);
			}
		}
		if (step.error) {
			for (const el of step.error.split("\n")) {
				const errLines = wrapText(el);
				for (const el2 of errLines) {
					lines.push(
						<Text key={key++} color={colors.error}>
							{`  │    ${el2}`}
						</Text>,
					);
				}
			}
		}
	}

	return <Box flexDirection="column">{lines}</Box>;
}

// ===== Main component =====

export default function ConversationThread({
	userInput,
	threadItems,
	isRunning,
	liveState,
	finalAnswer,
	steps,
	planSummary,
	planTotal,
}: ConversationThreadProps) {
	const wrapText = useTextWrap(5);

	// --- Build flat display list ---
	const displayItems: DisplayItem[] = [];

	// 1. User message
	displayItems.push({ type: "user-message", source: userInput });

	// 2. Step card (if steps exist)
	const hasSteps = steps && steps.length > 0;
	if (hasSteps) {
		displayItems.push({
			type: "step-card",
			source: { steps, planSummary, planTotal } as any,
		});
	}

	// 3. Thinking state
	if (liveState?.isThinking && hasSteps) {
		displayItems.push({ type: "thinking", source: liveState });
	}

	// 4. Completed tool calls
	for (const item of threadItems) {
		displayItems.push({ type: "tool-call", source: item });
	}

	// 5. Streaming text (when not thinking but still running)
	if (
		isRunning &&
		liveState &&
		!liveState.isThinking &&
		liveState.streamingText
	) {
		displayItems.push({ type: "thinking", source: liveState });
	}

	// 6. Final answer
	if (!isRunning && finalAnswer) {
		// Skip final answer if it's already in step card summary
		if (
			!hasSteps ||
			finalAnswer.length > 100 ||
			!planSummary?.includes(finalAnswer.slice(0, 50))
		) {
			displayItems.push({ type: "answer", source: finalAnswer });
		}
	}

	if (displayItems.length === 0) return null;

	// --- Render with connectors ---
	const renderedLines: React.ReactNode[] = [];
	let lineKey = 0;

	for (let i = 0; i < displayItems.length; i++) {
		const item = displayItems[i];
		const total = displayItems.length;
		const prefixes = getThreadPrefixes(i, total, item.type);

		switch (item.type) {
			case "user-message": {
				const userText = item.source as string;
				const textLines = userText.split("\n");
				for (let j = 0; j < textLines.length; j++) {
					const wrapped = wrapText(textLines[j]);
					for (let k = 0; k < wrapped.length; k++) {
						const isFirst = j === 0 && k === 0;
						renderedLines.push(
							<Text key={lineKey++} color={colors.indigo}>
								{isFirst ? `  ● ${wrapped[k]}` : `  │ ${wrapped[k]}`}
							</Text>,
						);
					}
				}
				if (
					prefixes.spacer &&
					i < displayItems.length - 1 &&
					displayItems[i + 1].type !== item.type
				) {
					renderedLines.push(
						<Text key={lineKey++} dimColor>
							{prefixes.spacer}
						</Text>,
					);
				}
				break;
			}

			case "tool-call": {
				const tc = item.source as ThreadItem;
				const { text, color } = renderToolCallText(tc);
				const wrappedHeader = wrapText(text);
				for (let j = 0; j < wrappedHeader.length; j++) {
					const pfx = j === 0 ? prefixes.header : prefixes.content;
					renderedLines.push(
						<Text key={lineKey++} color={color as any}>
							{pfx}
							{wrappedHeader[j]}
						</Text>,
					);
				}
				if (!tc.result.success && tc.result.error) {
					for (const errLine of tc.result.error.split("\n")) {
						const wrapped = wrapText(errLine);
						for (const wl of wrapped) {
							renderedLines.push(
								<Text key={lineKey++} color={colors.error}>
									{prefixes.content}
									{wl}
								</Text>,
							);
						}
					}
				}
				if (
					prefixes.spacer &&
					i < displayItems.length - 1 &&
					displayItems[i + 1].type !== item.type
				) {
					renderedLines.push(
						<Text key={lineKey++} dimColor>
							{prefixes.spacer}
						</Text>,
					);
				}
				break;
			}

			case "step-card": {
				const props = item.source as any as ConversationThreadProps;
				const cardSteps = props.steps || EMPTY_STEPS;
				const cardSummary = props.planSummary;
				const cardTotal = props.planTotal;
				renderedLines.push(
					<Text key={lineKey++} bold color={colors.gold}>
						{prefixes.header || "  │ "}执行计划
					</Text>,
				);
				const completed = cardSteps.filter(
					(s) => s.status === "completed",
				).length;
				const total = cardTotal || cardSteps.length;
				if (cardSummary) {
					renderedLines.push(
						<Text key={lineKey++} dimColor>
							{`  │ ${cardSummary} (${completed}/${total})`}
						</Text>,
					);
				}
				for (const step of cardSteps) {
					const { icon, color } = getStepIconAndColor(step);
					renderedLines.push(
						<Text key={lineKey++} color={color as any}>
							{`  │ ${icon} ${step.label}`}
						</Text>,
					);
					if (step.status === "running" && liveState?.streamingText) {
						const preview = liveState.streamingText.slice(0, 80);
						const previewSuffix =
							liveState.streamingText.length > 80 ? "..." : "";
						renderedLines.push(
							<Text key={lineKey++} dimColor>
								{`  │   ${preview}${previewSuffix}`}
							</Text>,
						);
					}
					if (step.error) {
						renderedLines.push(
							<Text key={lineKey++} color={colors.error}>
								{`  │   ${step.error}`}
							</Text>,
						);
					}
				}
				if (
					prefixes.spacer &&
					i < displayItems.length - 1 &&
					displayItems[i + 1].type !== item.type
				) {
					renderedLines.push(
						<Text key={lineKey++} dimColor>
							{prefixes.spacer}
						</Text>,
					);
				}
				break;
			}

			case "thinking": {
				const ls = item.source as unknown as LiveState;
				renderedLines.push(
					<Text key={lineKey++} color={colors.thinking}>
						{prefixes.header}
						<Spinner /> 玄码思考中... (第 {ls.turn} 轮)
					</Text>,
				);
				if (ls.streamingText) {
					const textLines = ls.streamingText.split("\n");
					for (const rawLine of textLines) {
						if (!rawLine.trim()) {
							renderedLines.push(
								<Text key={lineKey++}>{prefixes.content}</Text>,
							);
							continue;
						}
						const display =
							rawLine.length > 100 ? `${rawLine.slice(0, 100)}...` : rawLine;
						const wrapped = wrapText(display);
						for (const wl of wrapped) {
							const segments = parseMarkdownLine(wl);
							const flatText =
								prefixes.content + segments.map((s) => s.text).join("");
							renderedLines.push(
								<Text key={lineKey++} dimColor>
									{flatText}
								</Text>,
							);
						}
					}
				}
				if (
					prefixes.spacer &&
					i < displayItems.length - 1 &&
					displayItems[i + 1].type !== item.type
				) {
					renderedLines.push(
						<Text key={lineKey++} dimColor>
							{prefixes.spacer}
						</Text>,
					);
				}
				break;
			}

			case "answer": {
				const answer = item.source as string;
				const answerLines = answer.split("\n");
				let inCodeBlock = false;

				renderedLines.push(
					<Text key={lineKey++} color={colors.thinking} bold>
						{prefixes.header}
						{LABEL.AI.trim()}
					</Text>,
				);
				for (const rawLine of answerLines) {
					if (rawLine.trimStart().startsWith("```")) {
						inCodeBlock = !inCodeBlock;
						continue;
					}
					if (inCodeBlock) {
						const wrapped = wrapText(rawLine);
						for (const wl of wrapped) {
							renderedLines.push(
								<Text key={lineKey++} dimColor>
									{prefixes.content}
									{wl}
								</Text>,
							);
						}
						continue;
					}
					if (!rawLine.trim()) {
						renderedLines.push(<Text key={lineKey++}>{prefixes.content}</Text>);
						continue;
					}
					const wrapped = wrapText(rawLine);
					for (const wl of wrapped) {
						const segments = parseMarkdownLine(wl);
						const flatText =
							prefixes.content + segments.map((s) => s.text).join("");
						const hasBold = segments.some((s) => s.bold);
						const hasDim = segments.some((s) => s.dim);
						const segColor = segments.find((s) => s.color)?.color;
						renderedLines.push(
							<Text
								key={lineKey++}
								bold={hasBold}
								dimColor={hasDim}
								color={segColor as any}
							>
								{flatText}
							</Text>,
						);
					}
				}
				break;
			}
		}
	}

	return (
		<Box flexDirection="column" marginY={1}>
			{renderedLines}
		</Box>
	);
}
