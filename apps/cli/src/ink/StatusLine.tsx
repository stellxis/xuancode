import { Box, Text } from "ink";
import React, { useMemo } from "react";
import { colors } from "./theme";

interface StatusLineProps {
	mode: string;
	provider: string;
	modelName: string;
	turn?: number;
	contextUsage?: number;
	compactLevel?: number;
	/** 记忆条目数（提供时显示活跃度） */
	memoryCount?: number;
	/** 记忆活跃度 0-100 */
	memoryActivity?: number;
}

const TREND_MAP = ["↘", "→", "↗"] as const;

function getMemoryTrend(activity: number): { icon: string; color: string } {
	if (activity > 60) return { icon: TREND_MAP[2], color: colors.green };
	if (activity > 30) return { icon: TREND_MAP[1], color: colors.gold };
	return { icon: TREND_MAP[0], color: colors.dim };
}

export default React.memo(function StatusLine({
	mode,
	provider,
	modelName,
	turn,
	contextUsage,
	compactLevel,
	memoryCount,
	memoryActivity,
}: StatusLineProps) {
	const modeColor = colors.mode[mode] || colors.dim;

	const items: { text: string; color?: string }[] = [
		{ text: mode, color: modeColor },
		{ text: `${provider}/${modelName}` },
	];
	if (turn !== undefined) items.push({ text: `${turn}轮` });
	if (contextUsage !== undefined) items.push({ text: `${contextUsage}%` });
	if (compactLevel !== undefined && compactLevel > 0)
		items.push({ text: `Lv${compactLevel}` });

	// Memory indicator with trend
	const memoryPart = useMemo(() => {
		if (memoryCount === undefined) return null;
		if (memoryCount === 0) return { text: "记忆-", color: colors.dim };
		const trend = getMemoryTrend(memoryActivity ?? 50);
		return {
			text: `记忆${trend.icon} (${memoryCount}条, ${memoryActivity ?? 0}%)`,
			color: trend.color,
		};
	}, [memoryCount, memoryActivity]);

	if (memoryPart)
		items.push({ text: memoryPart.text, color: memoryPart.color });

	const line = items.map((i) => i.text).join(" · ");

	return (
		<Box>
			<Text color={colors.teal}>{line}</Text>
		</Box>
	);
});
