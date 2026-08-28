import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import React, { useState } from "react";
import { colors } from "./theme";

interface InputBarProps {
	onSubmit: (value: string) => void;
	disabled?: boolean;
	/** 决策面板输入模式：menu=分支菜单（禁用文本输入），text=自定义回答（启用） */
	answerMode?: "menu" | "text" | null;
	customPlaceholder?: string;
}

export default function InputBar({
	onSubmit,
	disabled,
	answerMode,
	customPlaceholder,
}: InputBarProps) {
	const [value, setValue] = useState("");

	const handleSubmit = (input: string) => {
		if (disabled || !input.trim()) return;
		setValue("");
		onSubmit(input.trim());
	};

	// 菜单选择期间不渲染 TextInput，避免键盘输入被文本框同时捕获
	if (answerMode === "menu") {
		return (
			<Box marginTop={1}>
				<Text color={colors.vermilion} bold>
					{" 玄 > "}
				</Text>
				<Text dimColor>
					按 ↑/↓ 或数字键选择分支 · Enter 确认 · Tab 切换问题
				</Text>
			</Box>
		);
	}

	const isAnsweringText = answerMode === "text" && !disabled;

	return (
		<Box marginTop={1}>
			<Text color={colors.vermilion} bold>
				{" 玄 > "}
			</Text>
			<TextInput
				value={value}
				onChange={setValue}
				onSubmit={handleSubmit}
				placeholder={
					isAnsweringText
						? customPlaceholder || "输入自定义回答…（Enter 提交）"
						: disabled
							? "执行中..."
							: "输入指令，/help 查看帮助"
				}
			/>
		</Box>
	);
}
