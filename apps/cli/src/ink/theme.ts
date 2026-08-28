/** 玄码国风色彩系统 — 五行五色 */

export const colors = {
	// ── 主色 ──
	vermilion: "#e8505a", // 朱砂红 — 主色、错误、高危
	indigo: "#4a6fa5", // 黛蓝 — 辅色、信息
	gold: "#c9a84c", // 金色 — 点缀、警告
	purple: "#805ad5", // 紫色 — 思考、推理
	green: "#48bb78", // 绿色 — 成功、完成

	// ── 语义色 ──
	success: "#48bb78",
	error: "#e8505a",
	warn: "#c9a84c",
	info: "#4a6fa5",
	thinking: "#805ad5",
	dim: "#6b7280",
	teal: "#38b2ac", // 青绿 — 状态栏

	// ── 信任模式色阶 ──
	mode: {
		plan: "#6b7280",
		default: "#e8505a",
		trust: "#c9a84c",
		auto: "#4a6fa5",
		bypass: "#805ad5",
	} as Record<string, string>,

	// ── 上下文用量色阶 ──
	context: {
		normal: "#6b7280",
		warn: "#c9a84c",
		danger: "#e8505a",
	},
} as const;

export const theme = {
	...colors,

	/** 上下文百分比 → 颜色 */
	contextColor(pct: number): string {
		return pct > 80
			? colors.context.danger
			: pct > 50
				? colors.context.warn
				: colors.context.normal;
	},
} as const;
