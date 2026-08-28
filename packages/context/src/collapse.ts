import type { Message } from "@xuancode/types";

/**
 * Level 3: Context-Collapse — Read-time projection (non-destructive)
 *
 * Creates a virtual projection of messages without modifying the original array.
 * This is critical — in Claude Code's architecture, the original messages array
 * is NEVER mutated by collapse; only the read view changes.
 */
export interface CollapseOptions {
	maxTotalChars: number;
	collapseRatio: number; // 0.0 - 1.0, how much to collapse
	preserveLastNTurns: number;
}

const DEFAULT_OPTIONS: CollapseOptions = {
	maxTotalChars: 150_000,
	collapseRatio: 0.7,
	preserveLastNTurns: 5,
};

/**
 * Collapsed message view — a thin wrapper that projects messages without copying
 */
export class CollapsedView {
	private original: Message[];
	private collapsed: Message[];
	private options: CollapseOptions;

	constructor(messages: Message[], options: Partial<CollapseOptions> = {}) {
		this.original = messages;
		this.options = { ...DEFAULT_OPTIONS, ...options };
		this.collapsed = this.buildCollapsed();
	}

	getMessages(): Message[] {
		return this.collapsed;
	}

	getOriginal(): Message[] {
		return this.original;
	}

	isCollapsed(): boolean {
		return this.collapsed.length < this.original.length;
	}

	getCollapseRatio(): number {
		return 1 - this.collapsed.length / this.original.length;
	}

	private buildCollapsed(): Message[] {
		const total = this.original.reduce((sum, m) => sum + m.content.length, 0);

		if (total <= this.options.maxTotalChars) {
			return this.original;
		}

		// Preserve recent turns
		const preserveCount = Math.min(
			this.options.preserveLastNTurns * 2,
			this.original.length,
		);
		const preserved = this.original.slice(-preserveCount);

		// Collapse older messages into a summary
		const toCollapse = this.original.slice(
			0,
			this.original.length - preserveCount,
		);

		if (toCollapse.length === 0) {
			return this.original;
		}

		const collapsedSummary = this.summarizeMessages(toCollapse);

		return [collapsedSummary, ...preserved];
	}

	private summarizeMessages(msgs: Message[]): Message {
		const toolCalls = msgs.filter(
			(m) => m.role === "assistant" && m.content.includes('"type"'),
		);
		const userMessages = msgs.filter(
			(m) => m.role === "user" && !m.content.startsWith("工具结果:"),
		);
		const userRequests = userMessages.map((m) => m.content.slice(0, 100));

		return {
			role: "system",
			content: `[上下文折叠: 较早的 ${msgs.length} 条消息已压缩]
- 用户请求: ${userRequests.join("; ").slice(0, 300)}
- 工具调用次数: ${toolCalls.length}
- 当前任务继续中...`,
		};
	}
}

/**
 * Quick collapse function (synchronous, non-destructive)
 */
export function contextCollapse(
	messages: Message[],
	maxChars?: number,
): Message[] {
	const view = new CollapsedView(
		messages,
		maxChars ? { maxTotalChars: maxChars } : undefined,
	);
	return view.getMessages();
}
