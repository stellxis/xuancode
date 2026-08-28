/** 线程连接符字符集 */
export const THREAD = {
	VLINE: "│", // │
	BRANCH: "├", // ├
	ELBOW: "└", // └
	HLINE: "─", // ─
	BOX_TL: "┌", // ┌
	BOX_BL: "└", // └
	BOX_VLINE: "│", // │
	BOX_TR: "┐", // ┐
	BOX_BR: "┘", // ┘
} as const;

export const LABEL = {
	USER: " 用户 ",
	AI: " 玄码 ",
} as const;

/** 工具类型 → 五行图标映射 */
export function toolIcon(type: string): string {
	const map: Record<string, string> = {
		list_dir: "☰",
		read_file: "☰",
		write_file: "☰",
		edit_file: "☰",
		glob: "☷",
		grep: "☷",
		search: "☷",
		web_search: "☵",
		web_fetch: "☵",
		shell: "☲",
		agent: "☶",
	};
	return map[type] || "☰";
}

/** 步骤状态 → 方块勾选框图标 */
export function stepStatusIcon(status: string): string {
	const map: Record<string, string> = {
		pending: "□",
		running: "◉",
		completed: "☑",
		failed: "✕",
		skipped: "⊟",
	};
	return map[status] || "□";
}

/** 格式化持续时间 */
export function formatDuration(ms?: number): string {
	if (!ms) return "";
	return ms > 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
}

/**
 * 将 displayItems 数组中的 item 根据位置渲染为带连接符前缀的 Ink Text 节点内容。
 *
 * @returns 对象包含 header（首行标记）、content（续行标记）、spacer（尾部空行标记）
 */
export function getThreadPrefixes(
	index: number,
	total: number,
	type: "user-message" | "tool-call" | "thinking" | "answer" | "step-card",
): { header: string; content: string; spacer: string } {
	if (index === 0) {
		return { header: "", content: "", spacer: `  ${THREAD.VLINE}` };
	}
	const isLast = index === total - 1;

	switch (type) {
		case "thinking":
			return {
				header: `  ${THREAD.VLINE}  `,
				content: `  ${THREAD.VLINE}  `,
				spacer: `  ${THREAD.VLINE}`,
			};
		case "tool-call":
			if (isLast) {
				return {
					header: `  ${THREAD.ELBOW}${THREAD.HLINE} `,
					content: `  ${THREAD.VLINE}  `,
					spacer: "",
				};
			}
			return {
				header: `  ${THREAD.BRANCH}${THREAD.HLINE} `,
				content: `  ${THREAD.VLINE}  `,
				spacer: `  ${THREAD.VLINE}`,
			};
		case "step-card":
			if (isLast) {
				return {
					header: `  ${THREAD.ELBOW}${THREAD.HLINE} `,
					content: `  ${THREAD.VLINE}  `,
					spacer: "",
				};
			}
			return {
				header: `  ${THREAD.BRANCH}${THREAD.HLINE} `,
				content: `  ${THREAD.VLINE}  `,
				spacer: `  ${THREAD.VLINE}`,
			};
		case "answer":
			return {
				header: `  ${THREAD.ELBOW}${THREAD.HLINE} `,
				content: `  ${THREAD.VLINE}  `,
				spacer: "",
			};
		default:
			return {
				header: `  ${THREAD.VLINE} `,
				content: `  ${THREAD.VLINE} `,
				spacer: `  ${THREAD.VLINE}`,
			};
	}
}

/**
 * 用户消息框渲染辅助
 * 返回三行内容: [topBorder, contentLine(s)..., bottomBorder]
 */
export function buildUserBox(input: string, label: string): string[] {
	const lines = input.split("\n");
	const maxWidth = Math.max(...lines.map((l) => l.length), label.length + 2);
	const hline = THREAD.HLINE.repeat(maxWidth + 2);

	const result: string[] = [];
	// 顶边
	result.push(`  ${THREAD.BOX_TL}${hline}${THREAD.BOX_TR}`);
	// 标签行
	result.push(
		`  ${THREAD.BOX_VLINE} ${label}${" ".repeat(Math.max(0, maxWidth - label.length + 1))}${THREAD.BOX_VLINE}`,
	);
	// 内容行
	for (const line of lines) {
		result.push(
			`  ${THREAD.BOX_VLINE} ${line}${" ".repeat(Math.max(0, maxWidth - line.length + 1))}${THREAD.BOX_VLINE}`,
		);
	}
	// 底边
	result.push(`  ${THREAD.BOX_BL}${hline}${THREAD.BOX_BR}`);
	return result;
}
