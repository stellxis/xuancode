/**
 * 国风科技色彩系统
 *
 * 基色: 墨色背景,玄青面板
 * 强调: 朱砂红主色,黛蓝辅色,金色点缀
 */

export const colors = {
	// === 基色 ===
	/** 墨色 — 深邃背景 */
	ink: "#0a0a0f",
	/** 玄青 — 面板背景 */
	darkBlue: "#1a1a2e",
	/** 银灰 — 次要文字 */
	silver: "#6b7280",
	/** 月白 — 主要文字 */
	moonWhite: "#e2e8f0",

	// === 强调色 ===
	/** 朱砂红 — 主色/强调 */
	vermilion: "#e8505a",
	/** 黛蓝 — 辅助色 */
	indigo: "#4a6fa5",
	/** 金色 — 点缀/高亮 */
	gold: "#c9a84c",
	/** 翠绿 — 成功/完成 */
	jade: "#48bb78",
	/** 墨紫 — 思考/处理中 */
	purple: "#805ad5",

	// === 功能色 ===
	success: "#48bb78",
	warning: "#ecc94b",
	error: "#e8505a",
	info: "#4a6fa5",
	muted: "#6b7280",
};

/**
 * 五行色彩映射
 */
export const elementColors: Record<string, string> = {
	metal: "#e2e8f0", // 金 — 白
	wood: "#48bb78", // 木 — 绿
	water: "#4a6fa5", // 水 — 蓝
	fire: "#e8505a", // 火 — 红
	earth: "#c9a84c", // 土 — 黄
};

/**
 * 五行状态图标
 */
export const elementIcons: Record<string, string> = {
	metal: "☰",
	wood: "☷",
	water: "☵",
	fire: "☲",
	earth: "☶",
};

export const elementNames: Record<string, string> = {
	metal: "金",
	wood: "木",
	water: "水",
	fire: "火",
	earth: "土",
};

/**
 * ANSI 256 color codes for terminal
 */
export const ansi = {
	vermilion: "\x1b[38;5;196m",
	indigo: "\x1b[38;5;68m",
	gold: "\x1b[38;5;220m",
	jade: "\x1b[38;5;78m",
	purple: "\x1b[38;5;99m",
	silver: "\x1b[38;5;244m",
	moonWhite: "\x1b[38;5;255m",
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	strikethrough: "\x1b[9m",
};
