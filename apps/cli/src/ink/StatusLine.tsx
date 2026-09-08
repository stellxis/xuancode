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

/** 信任模式国风单字（观/问/信/任/化） */
const MODE_LABELS: Record<string, string> = {
	plan: "观",
	default: "问",
	trust: "信",
	auto: "任",
	bypass: "化",
};

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
		{ text: MODE_LABELS[mode] || mode, color: modeColor },
		{ text: `${provider}/${modelName}` },
	];
	if (turn !== undefined && turn > 0) items.push({ text: `${turn}轮` });
	// 0% 与 ContextWaterline 的隐藏口径一致，空闲时不显示噪音
	if (contextUsage !== undefined && contextUsage > 0)
		items.push({ text: `${contextUsage}%` });
	if (compactLevel !== undefined && compactLevel > 0)
		items.push({ text: `Lv${compactLevel}` });

	// Memory indicator with trend
	const memoryPart = useMemo(() => {
		if (memoryCount === undefined) return null;
		if (memoryCount === 0) return { text: "记忆-", color: colors.dim };
		const trend = getMemoryTrend(memoryActivity ?? 50);
		return {
			text: `记忆${trend.icon} (${memoryCount}, ${memoryActivity ?? 0}%)`,
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
