import chalk from "chalk";
import {
	getDefaultElementStatuses,
	renderElement,
} from "./components/elements";
import { ansi, colors, elementIcons, elementNames } from "./theme/colors";

export function showBanner(): void {
	const banner = `
    ████████████████████████████████████████
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
    ██       AI Agent Harness v0.1        ██
    ██                                    ██
    ████████████████████████████████████████
  `;

	console.log(chalk.hex("#c43a31")(banner));

	// 五行 status bar
	const statuses = getDefaultElementStatuses();
	const elements = statuses.map(renderElement).join("  ");
	console.log(chalk.hex("#4a6fa5")(`  ${elements}\n`));
}

export function showHelp(): void {
	const s = chalk.hex("#6b7280");
	const p = chalk.hex("#805ad5");
	const g = chalk.hex("#c9a84c");
	const b = chalk.hex("#4a6fa5");
	const w = chalk.hex("#e2e8f0");
	const r = chalk.hex("#e8505a");
	const dim = chalk.dim;

	console.log("");
	console.log(
		r.bold("  ┌─ 玄码指令 ─────────────────────────────────────────┐"),
	);

	console.log(
		`  │ ${g.bold("/help")}      ${dim("—")} ${w("显示此帮助面板")}${dim("                        │")}`,
	);
	console.log(
		`  │ ${g.bold("/status")}   ${dim("—")} ${w("显示当前会话状态：模式/模型/轮次/上下文")}${dim("   │")}`,
	);
	console.log(
		`  │ ${g.bold("/mode")}     ${dim("—")} ${w("切换信任模式：plan / default / trust / auto / bypass")}${dim(" │")}`,
	);
	console.log(
		`  │ ${g.bold("exit/quit")}  ${dim("—")} ${w("退出玄码")}${dim("                                    │")}`,
	);
	console.log(
		r("  ├────────────────────────────────────────────────────────┤"),
	);

	console.log(
		`  │ ${b.bold("信任模式")}                                          │`,
	);
	console.log(
		`  │ ${dim("  观(plan)   ")}${s("— 仅规划，不执行任何操作")}${dim("                         │")}`,
	);
	console.log(
		`  │ ${dim("  问(default)")}${s("— 每次执行前询问")}${dim("                              │")}`,
	);
	console.log(
		`  │ ${dim("  信(trust)  ")}${s("— 文件自动，Shell 询问")}${dim("                          │")}`,
	);
	console.log(
		`  │ ${dim("  任(auto)   ")}${s("— 自动决策低风险操作")}${dim("                            │")}`,
	);
	console.log(
		`  │ ${dim("  化(bypass) ")}${s("— 完全自动，不确认")}${dim("                              │")}`,
	);
	console.log(
		r("  ├────────────────────────────────────────────────────────┤"),
	);

	console.log(
		`  │ ${b.bold("工具分类")}                                          │`,
	);
	console.log(
		`  │ ${dim("  ☰ 金 · 文件系统")}${s(" : read_file / write_file / edit_file / list_dir")}${dim(" │")}`,
	);
	console.log(
		`  │ ${dim("  ☷ 木 · 代码理解")}${s(" : glob / grep")}${dim("                                     │")}`,
	);
	console.log(
		`  │ ${dim("  ☵ 水 · 网络数据")}${s(" : web_search / web_fetch")}${dim("                             │")}`,
	);
	console.log(
		`  │ ${dim("  ☲ 火 · 执行")}${s("    : shell / git_status / git_diff / git_log")}${dim("          │")}`,
	);
	console.log(
		`  │ ${dim("            ")}${s("")}${s("git_branch / git_commit / git_push")}${dim("            │")}`,
	);
	console.log(
		`  │ ${dim("  ☶ 土 · 协作")}${s("    : MCP 插件工具 / 子 Agent")}${dim("                           │")}`,
	);
	console.log(
		r("  ├────────────────────────────────────────────────────────┤"),
	);

	console.log(
		`  │ ${b.bold("快速示例")}                                          │`,
	);
	console.log(
		`  │ ${dim("  ")}${w('"查看项目目录"')}${dim("     → ")}${s("list_dir / glob 自动调用")}${dim("            │")}`,
	);
	console.log(
		`  │ ${dim("  ")}${w('"修改文件内容"')}${dim("     → ")}${s("read_file → edit_file 流程")}${dim("        │")}`,
	);
	console.log(
		`  │ ${dim("  ")}${w('"查看 git 状态"')}${dim("    → ")}${s("git_status / git_log / git_diff")}${dim("     │")}`,
	);
	console.log(
		`  │ ${dim("  ")}${w('"搜索所有 TODO"')}${dim("    → ")}${s("grep 自动搜索")}${dim("                     │")}`,
	);
	console.log(
		r("  └────────────────────────────────────────────────────────┘"),
	);
	console.log("");
}

export function showStatusLine(
	mode: string,
	provider: string,
	modelName: string,
	turnCount?: number,
	contextUsage?: number,
	compactLevel?: number,
	memoryLoaded?: boolean,
): void {
	const dim = chalk.dim;
	const parts: string[] = [];

	// Trust mode indicator (colored by level)
	const modeColors: Record<string, string> = {
		plan: "#6b7280",
		default: "#e8505a",
		trust: "#c9a84c",
		auto: "#4a6fa5",
		bypass: "#805ad5",
	};
	const modeColor = modeColors[mode] || "#6b7280";
	parts.push(`${chalk.hex(modeColor)(`五行 · ${mode}`)}`);

	parts.push(`${dim("模型 ·")} ${provider}/${modelName}`);

	if (turnCount !== undefined) {
		parts.push(`${dim("轮次 ·")} ${turnCount}`);
	}
	if (contextUsage !== undefined) {
		const color =
			contextUsage > 80 ? "#e8505a" : contextUsage > 50 ? "#c9a84c" : "#6b7280";
		parts.push(`${dim("上下文 ·")} ${chalk.hex(color)(`${contextUsage}%`)}`);
	}
	if (compactLevel !== undefined && compactLevel > 0) {
		const levelNames = ["关", "剪", "微", "坍", "自"];
		parts.push(
			`${dim("压缩 ·")} Lv${compactLevel} ${levelNames[compactLevel] || ""}`,
		);
	}
	if (memoryLoaded !== undefined) {
		parts.push(memoryLoaded ? `${dim("记忆 ·")} ✓` : `${dim("记忆 ·")} -`);
	}

	console.log(`  ${parts.join("  |  ")}\n`);
}

export function showExecutionSummary(
	turnCount: number,
	toolCallCount: number,
	duration: number,
	errorCount: number,
	contextUsage: number,
): void {
	const durStr =
		duration > 1000
			? `${(duration / 1000).toFixed(1)}s`
			: `${duration.toFixed(0)}ms`;
	const g = chalk.hex("#4a6fa5");
	const dim = chalk.dim;

	console.log("");
	console.log(g("  ┌─ 执行摘要 ──────────────────────────────────┐"));
	console.log(
		g(`  │ ${dim("轮次")}    ${turnCount}                    `) + g("│"),
	);
	console.log(
		g(`  │ ${dim("工具")}    ${toolCallCount} 次调用               `) + g("│"),
	);
	console.log(
		g(`  │ ${dim("耗时")}    ${durStr}                    `) + g("│"),
	);
	console.log(
		g(`  │ ${dim("错误")}    ${errorCount}                    `) + g("│"),
	);
	console.log(
		g(`  │ ${dim("上下文")}  ${contextUsage}%                    `) + g("│"),
	);
	console.log(g("  └────────────────────────────────────────────┘"));
	console.log("");
}
