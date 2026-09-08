/**
 * SessionTimeline — 会话历史时间线渲染（App.tsx 拆出的展示组件）
 */

import { Box, Static, Text } from "ink";
import { visualLen, wrapVisual } from "./appText";
import { parseMarkdownLine, resolveMdColor } from "./markdown";
import { colors } from "./theme";
import type { SessionLog } from "./useTaskRunner";

export default function SessionTimeline({ logs }: { logs: SessionLog[] }) {
	if (logs.length === 0) return null;

	return (
		<Static items={logs}>
			{(log, idx) => {
				const columns = process.stdout.columns || process.stderr?.columns || 80;
				// 前缀 "  │ " 视觉宽度 = 4 (2空格 + │双宽)
				const contentMax = columns - 4;
				// 先按 \n 分割，再对每行进行视觉宽度换行
				const rawLines = log.output.split("\n");
				const shouldTrunc = visualLen(log.output) > 200;
				// 收集所有需要渲染的行：原始行 + 换行后的续行
				const allLines: { raw: string; isFirstOfPara: boolean }[] = [];
				rawLines.forEach((rawLine) => {
					const wrapped = wrapVisual(rawLine, contentMax);
					wrapped.forEach((w, wIdx) => {
						allLines.push({ raw: w, isFirstOfPara: wIdx === 0 });
					});
				});
				const displayLines = shouldTrunc ? allLines.slice(0, 5) : allLines;
				// Dot color = action type
				const dotColor =
					log.toolCallCount === 0
						? colors.success
						: log.toolCallCount > 5
							? colors.vermilion
							: colors.indigo;
				return (
					<Box key={`s${log.id}`} flexDirection="column">
						{/* Timeline continuation spacer between sessions */}
						{idx > 0 && <Text dimColor>{"  │"}</Text>}
						{/* Input line */}
						<Text color={dotColor}> ● {log.input}</Text>
						{/* Output lines - each line has prefix */}
						{displayLines.map(({ raw, isFirstOfPara }, li) => {
							const segs = parseMarkdownLine(raw);
							const prefix = isFirstOfPara ? "  │ " : "  │ ";
							const renderedSegs = segs.map((seg, si) => (
								<Text
									key={si}
									bold={seg.bold}
									dimColor={seg.dim}
									color={resolveMdColor(seg.color)}
									strikethrough={seg.strikethrough}
								>
									{seg.text}
								</Text>
							));
							return (
								<Box key={`o${li}`} flexDirection="row">
									<Text dimColor>{prefix}</Text>
									{renderedSegs}
								</Box>
							);
						})}
						{shouldTrunc && (
							<Text dimColor>{"  │ （完整输出↑ 对话区域）"}</Text>
						)}
						<Text
							dimColor
						>{`  │ ${log.turnCount} 轮 · ${log.toolCallCount} 工具`}</Text>
					</Box>
				);
			}}
		</Static>
	);
}
