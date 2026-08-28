import type { AgentState, Message } from "@xuancode/types";

/**
 * Level 4: Auto-Compact — LLM-based conversation summarization
 *
 * This is the most expensive compaction level (~2s latency).
 * It uses the LLM to produce a structured summary of the conversation.
 *
 * In production, this calls the model. In this implementation,
 * we provide a structured heuristic summary as fallback.
 */

export interface AutoCompactOptions {
	maxSummaryLength: number;
	preserveToolResults: boolean;
}

const DEFAULT_OPTIONS: AutoCompactOptions = {
	maxSummaryLength: 2000,
	preserveToolResults: true,
};

/**
 * 9-segment compact summary structure (from Claude Code's design)
 */
export interface CompactSummary {
	sessionGoal: string;
	completedTasks: string[];
	currentState: string;
	keyDecisions: string[];
	filesChanged: string[];
	issuesFound: string[];
	pendingActions: string[];
	userPreferences: string[];
	criticalContext: string;
}

export function generateCompactSummary(
	messages: Message[],
	options: Partial<AutoCompactOptions> = {},
): CompactSummary {
	const opts = { ...DEFAULT_OPTIONS, ...options };

	const userMessages = messages.filter(
		(m) => m.role === "user" && !m.content.startsWith("工具结果:"),
	);
	const assistantMessages = messages.filter((m) => m.role === "assistant");
	// M1(C3)：原生路径工具结果以 role:"tool" 消息回灌，一并纳入工具结果摘要
	const toolResults = messages.filter(
		(m) => m.role === "tool" || m.content.startsWith("工具结果:"),
	);
	const toolCalls = assistantMessages.filter(
		(m) => m.content.includes('"type"') || (m.toolCalls?.length ?? 0) > 0,
	);

	const filesChanged = extractFilesChanged(toolResults);
	const completedTasks = extractCompletedTasks(assistantMessages);
	const issuesFound = extractIssues(toolResults);

	return {
		sessionGoal: userMessages[0]?.content.slice(0, 200) || "未知",
		completedTasks: completedTasks.slice(0, 5),
		currentState: `已完成 ${completedTasks.length} 个任务, 执行 ${toolCalls.length} 次工具调用`,
		keyDecisions: [],
		filesChanged,
		issuesFound,
		pendingActions: [],
		userPreferences: [],
		criticalContext: opts.preserveToolResults
			? `最后工具结果: ${toolResults[toolResults.length - 1]?.content.slice(0, 200) || "无"}`
			: "",
	};
}

/**
 * Build a compacted message list from a summary
 */
export function buildCompactedMessages(
	summary: CompactSummary,
	recentMessages: Message[],
): Message[] {
	const summaryText = `[自动压缩摘要]
会话目标: ${summary.sessionGoal}
已完成: ${summary.completedTasks.join("; ")}
变更文件: ${summary.filesChanged.join(", ")}
${summary.criticalContext ? `关键上下文: ${summary.criticalContext}` : ""}`;

	return [
		{ role: "system", content: summaryText },
		...recentMessages.slice(-10),
	];
}

function extractFilesChanged(toolResults: Message[]): string[] {
	const files: string[] = [];
	for (const msg of toolResults) {
		if (msg.content.includes("写入成功")) {
			const match = msg.content.match(/写入成功:\s*(\S+)/);
			if (match) files.push(match[1]);
		}
	}
	return files;
}

function extractCompletedTasks(assistantMessages: Message[]): string[] {
	const tasks: string[] = [];
	for (const msg of assistantMessages) {
		if (!msg.content.includes('"type"')) {
			const lines = msg.content
				.split("\n")
				.filter((l) => l.length > 10 && l.length < 200);
			tasks.push(...lines.slice(0, 3));
		}
	}
	return tasks.slice(0, 10);
}

function extractIssues(toolResults: Message[]): string[] {
	const issues: string[] = [];
	for (const msg of toolResults) {
		if (msg.content.includes('"error"')) {
			try {
				const parsed = JSON.parse(msg.content.replace("工具结果: ", ""));
				if (parsed.error) issues.push(parsed.error);
			} catch {
				/* skip */
			}
		}
	}
	return issues;
}
