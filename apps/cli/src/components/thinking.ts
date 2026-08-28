import { ansi } from "../theme/colors";

/**
 * Render a thinking/progress indicator
 */
export function renderThinkingFrame(dots: number): string {
	const frames = ["◎", "◉", "●", "◉"];
	const frame = frames[dots % frames.length];
	return `${ansi.purple}  ${frame}  思考中...${ansi.reset}`;
}

/**
 * Render a tool call being parsed
 */
export function renderToolCallDetection(raw: string): string {
	const preview = raw.slice(0, 80).replace(/\n/g, " ");
	return `${ansi.indigo}  ⚡  解析工具调用: ${preview}${ansi.reset}`;
}

/**
 * Render step completion with timing
 */
export function renderStepComplete(step: string, durationMs: number): string {
	const duration =
		durationMs > 1000
			? `${(durationMs / 1000).toFixed(1)}s`
			: `${durationMs.toFixed(0)}ms`;
	return `${ansi.jade}  ✓ ${step} ${ansi.dim}[${duration}]${ansi.reset}`;
}

/**
 * Render error message in UI
 */
export function renderError(msg: string): string {
	return `${ansi.vermilion}  ⚠ ${msg}${ansi.reset}`;
}
