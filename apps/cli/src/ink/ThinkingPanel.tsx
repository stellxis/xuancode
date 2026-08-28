import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { colors } from "./theme";
import { THREAD } from "./threadConst";

interface ThinkingPanelProps {
	turn: number;
	label?: string;
	text?: string;
	/** 如果是最后一项（之后无工具调用/回答）, 使用 └─ 否则 ├─ */
	isLast?: boolean;
}

const SPINNERS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export default function ThinkingPanel({
	turn,
	label,
	text,
	isLast,
}: ThinkingPanelProps) {
	const [frame, setFrame] = useState(0);

	useEffect(() => {
		const timer = setInterval(() => {
			setFrame((f) => (f + 1) % SPINNERS.length);
		}, 120);
		return () => clearInterval(timer);
	}, []);

	const spinner = SPINNERS[frame];
	const message = label || `玄码思考中... (第 ${turn} 轮)`;
	const prefix = isLast
		? `  ${THREAD.ELBOW}${THREAD.HLINE} `
		: `  ${THREAD.BRANCH}${THREAD.HLINE} `;
	const continuation = isLast ? "     " : `  ${THREAD.VLINE}  `;

	return (
		<Box flexDirection="column" marginTop={1}>
			<Box>
				<Text color={colors.thinking}>{`${prefix}${spinner} ${message}`}</Text>
			</Box>
			{text && (
				<Box flexDirection="column">
					{text.split("\n").map((line, i) => (
						<Text key={i} color={colors.thinking} dimColor>
							{continuation}
							{line.length > 80 ? `${line.slice(0, 80)}...` : line}
						</Text>
					))}
				</Box>
			)}
		</Box>
	);
}
