import { Box, Text } from "ink";
import type React from "react";
import { colors } from "./theme";

interface ContextWaterlineProps {
	/** Context usage percentage (0-100) */
	contextUsage?: number;
	/** Whether a task is currently running */
	running: boolean;
}

const BAR_WIDTH = 20;

function renderBar(pct: number): string {
	const filled = Math.round((pct / 100) * BAR_WIDTH);
	return "█".repeat(filled) + "░".repeat(Math.max(0, BAR_WIDTH - filled));
}

const ContextWaterline: React.FC<ContextWaterlineProps> = ({
	contextUsage,
	running,
}) => {
	if (contextUsage === undefined || contextUsage === 0) return null;
	if (contextUsage <= 50 && !running) return null;

	const barColor =
		contextUsage > 80
			? colors.error
			: contextUsage > 50
				? colors.gold
				: colors.green;
	const bar = renderBar(contextUsage);

	return (
		<Box marginLeft={2} marginBottom={1}>
			<Text>
				<Text dimColor>Context: </Text>
				<Text color={barColor}>{contextUsage}% </Text>
				<Text color={barColor}>{bar}</Text>
			</Text>
		</Box>
	);
};

export default ContextWaterline;
