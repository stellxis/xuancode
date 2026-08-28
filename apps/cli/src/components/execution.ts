import type { ToolResult } from "@xuancode/types";
import { ansi } from "../theme/colors";

export interface ExecutionEntry {
	toolType: string;
	params: Record<string, string | undefined>;
	result: ToolResult;
	timestamp: number;
}

/**
 * Render a single tool execution entry
 */
export function renderExecutionEntry(entry: ExecutionEntry): string {
	const icon = entry.result.success
		? `${ansi.jade}✓${ansi.reset}`
		: `${ansi.vermilion}✗${ansi.reset}`;
	const duration = entry.result.duration
		? entry.result.duration > 1000
			? `${(entry.result.duration / 1000).toFixed(1)}s`
			: `${entry.result.duration.toFixed(0)}ms`
		: "";
	const param =
		entry.params.path || entry.params.command || entry.params.pattern || "";
	const truncated = param.length > 60 ? `${param.slice(0, 60)}...` : param;

	return `  ${icon} ${entry.toolType} ${truncated}${duration ? ` ${ansi.dim}[${duration}]${ansi.reset}` : ""}`;
}

/**
 * Render execution panel header
 */
export function renderExecutionHeader(): string {
	return `${ansi.bold}${ansi.gold}  ┌─ 执行 ──────────────────────────────────┐${ansi.reset}`;
}

/**
 * Render execution panel footer
 */
export function renderExecutionFooter(toolCount: number): string {
	return `${ansi.bold}${ansi.gold}  └────────── ${toolCount} tools ──────────┘${ansi.reset}`;
}

/**
 * Render full execution panel
 */
export function renderExecutionPanel(entries: ExecutionEntry[]): string {
	if (entries.length === 0) return "";

	const lines = [
		renderExecutionHeader(),
		...entries.map(renderExecutionEntry),
		renderExecutionFooter(entries.length),
	];

	return lines.join("\n");
}
