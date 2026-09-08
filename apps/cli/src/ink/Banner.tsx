import { Box, Text } from "ink";
import React from "react";
import { colors } from "./theme";

export default React.memo(function Banner() {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Text color="#c43a31">
				{`    ████████████████████████████████████████
    ██                                    ██
    ██        ████████████████████        ██
    ██        ████████████████████        ██
    ██            ████████████            ██
    ██        ████████████████████        ██
    ██        ████████████████████        ██
    ██        ████████████████████        ██
    ██       █████████  ██████████        ██
    ██         █████████████████          ██
    ██       █████████████████████        ██
    ██       █████████████████████        ██
    ██                                    ██
    ██        玄码 · XUANCODE Desk        ██
    ██       AI Agent Harness v1.0        ██
    ██                                    ██
    ████████████████████████████████████████`}
			</Text>
			<Text color={colors.indigo}>{"  ☰ 金  ☷ 木  ☵ 水  ☲ 火  ☶ 土"}</Text>
		</Box>
	);
});
