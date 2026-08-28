import type { ElementStatus } from "@xuancode/types";
import { ansi, elementIcons, elementNames } from "../theme/colors";

/**
 * Render a single element status indicator
 */
export function renderElement(status: ElementStatus): string {
	const icon = elementIcons[status.element] || "?";
	const name = elementNames[status.element] || status.element;

	const statusColors: Record<string, string> = {
		idle: ansi.silver,
		running: ansi.purple,
		error: "\x1b[38;5;196m",
		done: ansi.jade,
	};

	const color = statusColors[status.status] || ansi.silver;
	const duration = status.duration
		? `${(status.duration / 1000).toFixed(1)}s`
		: "";

	return `${color}${icon} ${name}${duration ? ` ${duration}` : ""}${ansi.reset}`;
}

/**
 * Render the 五行 status line
 */
export function renderElementsPanel(statuses: ElementStatus[]): string {
	if (statuses.length === 0) return "";

	const parts = statuses.map(renderElement);
	return `  五行 · ${parts.join("  ")}`;
}

/**
 * Get default 五行 statuses
 */
export function getDefaultElementStatuses(): ElementStatus[] {
	const elements: Array<{
		element: "metal" | "wood" | "water" | "fire" | "earth";
		name: string;
	}> = [
		{ element: "metal", name: "调度" },
		{ element: "wood", name: "工具" },
		{ element: "water", name: "上下" },
		{ element: "fire", name: "安全" },
		{ element: "earth", name: "子体" },
	];

	return elements.map((e) => ({
		element: e.element,
		name: e.name,
		active: false,
		status: "idle" as const,
	}));
}
