import { type AgentState, type Message, StopReason } from "@xuancode/types";

export interface StopCondition {
	name: string;
	priority: number;
	check: (state: AgentState) => StopReason | null;
}

/**
 * 9种终止条件 — 严格按优先级排列
 *
 * Priority ordering (from Claude Code architecture):
 * 1. hooks.stop — external signal
 * 2. abort signal — user cancel
 * 2.5. workflow complete — all workflow steps done
 * 3. error threshold — too many consecutive errors
 * 4. context overflow — budget exceeded
 * 5. max turns — hit iteration limit
 * 6. no tool use — model responded directly (normal completion)
 * 7. empty response — model returned nothing
 * 8. success — explicit completion signal
 */
export const STOP_CONDITIONS: StopCondition[] = [
	{
		name: "hook_stop",
		priority: 1,
		check: (state) =>
			state.stopReason === StopReason.HOOK_STOP ? StopReason.HOOK_STOP : null,
	},
	{
		name: "abort",
		priority: 2,
		check: (state) =>
			state.stopReason === StopReason.ABORT ? StopReason.ABORT : null,
	},
	{
		name: "workflow_complete",
		priority: 2.5,
		check: (state) =>
			state.stopReason === StopReason.WORKFLOW_COMPLETE
				? StopReason.WORKFLOW_COMPLETE
				: null,
	},
	{
		name: "error_threshold",
		priority: 3,
		check: (state) => {
			if (state.consecutiveErrors >= 5) return StopReason.ERROR;
			if (state.error && state.turnCount > 1) return StopReason.ERROR;
			return null;
		},
	},
	{
		name: "context_overflow",
		priority: 4,
		check: (state) => {
			if (state.contextBudget <= 0) return StopReason.CONTEXT_OVERFLOW;
			// Rough estimate: average 50 chars per message overhead, 5 chars per token
			const totalChars = state.messages.reduce(
				(sum, m) => sum + m.content.length,
				0,
			);
			if (totalChars > state.maxContextBudget)
				return StopReason.CONTEXT_OVERFLOW;
			return null;
		},
	},
	{
		name: "max_turns",
		priority: 5,
		check: (state) =>
			state.turnCount >= state.maxTurns ? StopReason.MAX_TURNS : null,
	},
	{
		name: "no_tool_use",
		priority: 6,
		check: (state) => {
			if (state.turnCount < 1) return null;
			const lastAssistantMsg = [...state.messages]
				.reverse()
				.find((m) => m.role === "assistant");
			const lastUserMsg = [...state.messages]
				.reverse()
				.find((m) => m.role === "user");

			// If last assistant msg doesn't contain a tool call and we've had at least 1 turn
			if (lastAssistantMsg && !containsToolCall(lastAssistantMsg)) {
				// But only if the last user message isn't a tool result the model hasn't responded to
				if (lastUserMsg?.content.startsWith("工具结果:")) {
					return null; // Model hasn't responded yet
				}
				return StopReason.NO_TOOL_USE;
			}
			return null;
		},
	},
	{
		name: "empty_response",
		priority: 7,
		check: (state) => {
			const lastMsg = state.messages[state.messages.length - 1];
			if (lastMsg?.role === "assistant" && !lastMsg.content.trim()) {
				return StopReason.ERROR;
			}
			return null;
		},
	},
	{
		name: "success",
		priority: 8,
		check: (state) =>
			state.stopReason === StopReason.SUCCESS ? StopReason.SUCCESS : null,
	},
];

function containsToolCall(msg: Message): boolean {
	// Check if message contains a JSON object with "type" field
	if (/["']type["']\s*:/.test(msg.content)) return true;
	// Check if message contains XML <invoke> format
	if (/<invoke\s+name="/.test(msg.content)) return true;
	return false;
}

export function checkStopConditions(state: AgentState): StopReason | null {
	// Sort by priority (ascending) — lower number = higher priority
	const sorted = [...STOP_CONDITIONS].sort((a, b) => a.priority - b.priority);
	for (const condition of sorted) {
		const reason = condition.check(state);
		if (reason !== null) return reason;
	}
	return null;
}

/**
 * Create a context overflow check based on character budget
 */
export function createBudgetCheck(
	maxBudget: number,
): (messages: Message[]) => boolean {
	return (messages: Message[]) => {
		const total = messages.reduce((sum, m) => sum + m.content.length, 0);
		return total > maxBudget;
	};
}
