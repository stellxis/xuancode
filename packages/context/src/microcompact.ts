import type { Message } from "@xuancode/types";

/**
 * Level 2: Microcompact — Compress aged tool results
 *
 * Strategy:
 * - Replace verbose tool results with compact summaries
 * - Truncate file contents that are too long
 * - Remove unnecessary whitespace
 */
export interface MicroCompactOptions {
	maxToolResultLength: number;
	maxMessageLength: number;
	compressCodeBlocks: boolean;
}

const DEFAULT_OPTIONS: MicroCompactOptions = {
	maxToolResultLength: 800,
	maxMessageLength: 4000,
	compressCodeBlocks: true,
};

export function microCompact(
	messages: Message[],
	options: Partial<MicroCompactOptions> = {},
): Message[] {
	const opts = { ...DEFAULT_OPTIONS, ...options };

	return messages.map((msg) => {
		let content = msg.content;

		// Compress tool results
		if (msg.role === "user" && content.startsWith("工具结果:")) {
			content = compactToolResult(content, opts.maxToolResultLength);
		}

		// Compress code blocks
		if (opts.compressCodeBlocks && content.includes("```")) {
			content = compactCodeBlocks(content);
		}

		// Truncate overly long messages
		if (content.length > opts.maxMessageLength) {
			content = `${content.slice(0, opts.maxMessageLength)}\n...(已截断,原长 ${content.length} 字符)`;
		}

		return content !== msg.content ? { ...msg, content } : msg;
	});
}

function compactToolResult(content: string, maxLen: number): string {
	if (content.length <= maxLen) return content;

	try {
		const payload = content.slice(5); // Remove "工具结果:" prefix
		const parsed = JSON.parse(payload);

		if (parsed.data && parsed.data.length > maxLen) {
			const truncated = `${parsed.data.slice(0, maxLen)}...(已压缩 ${parsed.data.length} → ${maxLen})`;
			return `工具结果: ${JSON.stringify({ ...parsed, data: truncated })}`;
		}
	} catch {
		// Not JSON — just truncate
		return `${content.slice(0, maxLen)}...(已截断)`;
	}

	return content;
}

function compactCodeBlocks(content: string): string {
	const lines = content.split("\n");
	let inCodeBlock = false;
	let codeLineCount = 0;
	const compacted: string[] = [];

	for (const line of lines) {
		if (line.trimStart().startsWith("```")) {
			if (inCodeBlock) {
				// End of code block — add line count
				compacted.push(line);
				if (codeLineCount > 20) {
					compacted.push(`  (...代码块共 ${codeLineCount} 行,已折叠)`);
				}
				codeLineCount = 0;
			} else {
				// Start of code block
				compacted.push(line);
			}
			inCodeBlock = !inCodeBlock;
		} else if (inCodeBlock) {
			codeLineCount++;
			if (codeLineCount <= 20) {
				compacted.push(line);
			}
		} else {
			compacted.push(line);
		}
	}

	return compacted.join("\n");
}
