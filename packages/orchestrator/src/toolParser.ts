import type { ToolCallParams } from "@xuancode/types";

/**
 * Normalize model-hallucinated tag formats into standard XML tags.
 *
 * Some models (notably GLM/ZhipuAI) occasionally emit tool-call wrappers using
 * full-width pipe characters (U+FF5C) instead of ASCII angle brackets,
 * producing tokens like `<｜｜DSML｜｜tool_call>` or `<｜｜DSML｜｜invoke name="...">`.
 * The standard parser only recognizes `<tool_call>` / `<invoke>`, so without
 * normalization these wrappers leak into user-facing text and the tool call is
 * never executed (manifesting as an empty/garbled plan response).
 *
 * Rewrites the full-width pipe prefix to a plain `<` so downstream regexes
 * match the standard forms.
 */
function normalizeHallucinatedTags(text: string): string {
	return text.replace(/<\/?｜+DSML｜+/g, (m) =>
		m.startsWith("</") ? "</" : "<",
	);
}

/**
 * Extract JSON blocks from text — supports ```json, <tool_call>, and bare JSON
 */
export function extractJsonBlocks(text: string): string[] {
	const blocks: string[] = [];
	const normalized = normalizeHallucinatedTags(text);

	// Try <tool_call>/<tool_calls>...</tool_call>/</tool_calls> tags (DeepSeek native format;
	// 复数 <tool_calls> 是部分模型的格式幻觉变体)
	const toolCallRegex = /<tool_calls?>([\s\S]*?)<\/tool_calls?>/g;
	let match: RegExpExecArray | null;
	while (true) {
		match = toolCallRegex.exec(normalized);
		if (match === null) break;
		const trimmed = match[1].trim();
		if (trimmed) blocks.push(trimmed);
	}

	// Try code-fenced JSON blocks
	if (blocks.length === 0) {
		const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/g;
		while (true) {
			match = fenceRegex.exec(normalized);
			if (match === null) break;
			const trimmed = match[1].trim();
			if (trimmed && !blocks.includes(trimmed)) blocks.push(trimmed);
		}
	}

	// Try bare JSON objects (only if no structured format found)
	if (blocks.length === 0) {
		const objRegex = /\{(?:[^{}]|(?:\{(?:[^{}]|(?:\{[^{}]*\}))*\}))*\}/g;
		while (true) {
			match = objRegex.exec(normalized);
			if (match === null) break;
			const trimmed = match[0].trim();
			if (trimmed && !blocks.includes(trimmed)) blocks.push(trimmed);
		}
	}

	return blocks;
}

export function safeParse<T>(str: string): T | null {
	try {
		return JSON.parse(str) as T;
	} catch {
		return null;
	}
}

/**
 * Parse XML <invoke> blocks (DeepSeek XML function-calling format).
 * Format:
 *   <invoke name="tool_name">
 *     <parameter name="param_name">value</parameter>
 *   </invoke>
 */
export function extractInvokeBlocks(text: string): ToolCallParams[] {
	const results: ToolCallParams[] = [];
	const normalized = normalizeHallucinatedTags(text);
	// Match <invoke name="...">...</invoke>
	const invokeRegex = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
	let match: RegExpExecArray | null;
	while (true) {
		match = invokeRegex.exec(normalized);
		if (match === null) break;
		const toolName = match[1];
		const body = match[2].trim();
		const params: Record<string, unknown> = { type: toolName };

		// Extract <parameter name="...">value</parameter>
		const paramRegex =
			/<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/g;
		let pmatch: RegExpExecArray | null;
		while (true) {
			pmatch = paramRegex.exec(body);
			if (pmatch === null) break;
			const paramName = pmatch[1];
			let paramValue: string | boolean | number = pmatch[2].trim();
			// Try to parse as number
			const num = Number(paramValue);
			if (!Number.isNaN(num) && paramValue !== "") paramValue = num;
			// Try to parse as boolean
			if (paramValue === "true") paramValue = true;
			if (paramValue === "false") paramValue = false;
			params[paramName] = paramValue;
		}

		results.push(params as unknown as ToolCallParams);
	}
	return results;
}

/**
 * Parse ALL tool calls from model output — supports multiple tools per turn
 */
export function parseToolCall(text: string): ToolCallParams | null {
	const all = parseAllToolCalls(text);
	return all.length > 0 ? all[0] : null;
}

/**
 * Parse all tool calls from model output.
 * Supports formats: <tool_call>JSON</tool_call>, <invoke name="">XML</invoke>, JSON blocks
 */
export function parseAllToolCalls(text: string): ToolCallParams[] {
	// Try JSON formats first
	const blocks = extractJsonBlocks(text);
	const results: ToolCallParams[] = [];
	for (const block of blocks) {
		const parsed = safeParse<Record<string, unknown>>(block);
		if (parsed && typeof parsed.type === "string") {
			results.push(parsed as unknown as ToolCallParams);
		}
	}
	if (results.length > 0) return results;

	// Fallback: try XML <invoke> format (DeepSeek function-calling style)
	return extractInvokeBlocks(text);
}

/**
 * Strip reasoning content (everything before and including </think> tag).
 * Preserves ALL conversational text — only removes internal model reasoning blocks.
 * Tool calls are independently extracted by parseAllToolCalls() on the full text.
 */
export function stripThinkContent(text: string): string {
	let stripped = text.trim();

	// Remove complete think blocks (DeepSeek reasoning model output)
	const thinkTagRegex = /<think>[\s\S]*?<\/think>/gi;
	stripped = stripped.replace(thinkTagRegex, "");

	// Streaming-safe: if <think> is opened but not yet closed, strip everything after it
	const openThinkIdx = stripped.lastIndexOf("<think>");
	const closeThinkIdx = stripped.lastIndexOf("</think>");
	if (openThinkIdx > closeThinkIdx) {
		stripped = stripped.slice(0, openThinkIdx).trim();
	}

	// CRITICAL: Do NOT strip conversational text / Chinese explanations.
	// The model's own words provide essential context for the next turn.
	// parseAllToolCalls() independently extracts JSON tool calls from the full text.

	return stripped;
}

/**
 * Strip <tool_call> and <invoke> blocks from final user-facing text.
 * These are control-plane artifacts, never part of the answer.
 */
/**
 * 检测文本是否包含工具调用标签特征（<tool_call>/<tool_calls>/<invoke>/<parameter> 等）。
 * 用于区分「模型直接回复」与「模型想调工具但格式幻觉无法解析」。
 */
export function hasToolCallArtifacts(text: string): boolean {
	const normalized = normalizeHallucinatedTags(text);
	return /<(?:tool_calls?|invoke|parameter)[\s>]/.test(normalized);
}

/**
 * 移除 streamParser 注入的原生工具调用 JSON 行（含 "id":"call_..." + "type"）。
 * 原生 tool_calls 以裸 JSON 注入内容流（无 <tool_call> 标签），stripToolCalls 剥不掉，
 * 需要在这里剔除，避免泄漏到用户可见的流式/最终文本。
 */
export function stripNativeToolJson(text: string): string {
	return text.replace(/\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g, (m) => {
		try {
			const obj = JSON.parse(m);
			if (
				obj &&
				typeof obj === "object" &&
				typeof (obj as any).type === "string" &&
				typeof (obj as any).id === "string" &&
				(obj as any).id.startsWith("call_")
			) {
				return "";
			}
		} catch {
			/* 非合法 JSON，保留 */
		}
		return m;
	});
}

export function stripToolCalls(text: string): string {
	// Normalize hallucinated DSML tags first so the strip regexes below catch them.
	let stripped = normalizeHallucinatedTags(text);
	// Remove complete <tool_call>/<tool_calls>...</tool_call></tool_calls> blocks
	stripped = stripped.replace(/<tool_calls?>[\s\S]*?<\/tool_calls?>/gi, "");
	// Remove truncated <tool_call>/<tool_calls> blocks (output cut off mid-call, no closing tag)
	stripped = stripped.replace(/<tool_calls?>[\s\S]*/gi, "");
	// Remove <invoke name="...">...</invoke> blocks
	stripped = stripped.replace(/<invoke\s+name="[^"]*"[\s\S]*?<\/invoke>/gi, "");
	// Remove <parameter name="...">...</parameter> blocks
	stripped = stripped.replace(
		/<parameter\s+name="[^"]*"[^>]*>[\s\S]*?<\/parameter>/gi,
		"",
	);
	// Remove any stray remaining tool/parameter tags
	stripped = stripped.replace(
		/<\/?(?:tool_calls?|invoke|parameter)[^>]*>/gi,
		"",
	);
	// 移除残缺/独立的 <tool_call / </tool_call 标记（无闭合 >）。
	// DeepSeek V4 Flash 等模型会在正文中输出不完整的 <tool_call 片段（没有 >），
	// 上述规则都要求 >，剥不掉 → 泄漏到面板/最终文本。
	stripped = stripped.replace(/<\/?tool_calls?/gi, "");
	// Collapse 3+ consecutive newlines left after removal into 2 (content normalization)
	stripped = stripped.replace(/\n{3,}/g, "\n\n");
	return stripped;
}

/**
 * Check if text contains a tool call
 */
export function hasToolCall(text: string): boolean {
	return parseToolCall(text) !== null;
}
