import type { ToolResult } from "@xuancode/types";
import { Box, Text } from "ink";
import React from "react";
import { colors } from "./theme";
import { THREAD, formatDuration, toolIcon } from "./threadConst";

export interface ExecutionEntry {
	toolType: string;
	params: Record<string, string | undefined>;
	result: ToolResult;
	timestamp: number;
}

interface ExecutionPanelProps {
	entries: ExecutionEntry[];
}

function EntryRow({
	entry,
	isLast,
}: { entry: ExecutionEntry; isLast: boolean }) {
	const icon = toolIcon(entry.toolType);
	const ok = entry.result.success;
	const color = ok ? colors.success : colors.error;
	const mark = ok ? "✓" : "✗";
	const param =
		entry.params.path || entry.params.command || entry.params.pattern || "";
	const truncated = param.length > 60 ? `${param.slice(0, 60)}...` : param;
	const duration = formatDuration(entry.result.duration);
	const prefix = isLast
		? `  ${THREAD.ELBOW}${THREAD.HLINE} `
		: `  ${THREAD.BRANCH}${THREAD.HLINE} `;

	return (
		<Box>
			<Text color={color}>
				{prefix}
				{mark} <Text color={colors.indigo}>{icon}</Text>
				{` ${entry.toolType} ${truncated}`}
				{duration ? <Text dimColor>{` [${duration}]`}</Text> : null}
			</Text>
		</Box>
	);
}

export default function ExecutionPanel({ entries }: ExecutionPanelProps) {
	if (entries.length === 0) return null;

	return (
		<Box flexDirection="column" marginTop={1}>
			{entries.map((entry, i) => (
				<EntryRow
					key={`${entry.timestamp}-${i}`}
					entry={entry}
					isLast={i === entries.length - 1}
				/>
			))}
			<Text dimColor>{`  ${THREAD.VLINE}`}</Text>
		</Box>
	);
}
