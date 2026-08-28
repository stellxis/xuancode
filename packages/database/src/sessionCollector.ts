import type {
	ErrorEntry,
	LogEntry,
	MessageEntry,
	ToolCallEntry,
} from "@xuancode/session";
import type { AgentState, Message, ToolResult } from "@xuancode/types";

/**
 * SessionCollector — 从 runTaorLoop 回调中收集会话数据
 *
 * 用法:
 *   const collector = new SessionCollector();
 *   // 传入 onTurn: (turn, state) => collector.captureNewMessages(turn, state)
 *   // 传入 onToolCall: (tc, result) => collector.captureToolCall(turn, tc, result)
 *   // 传入 onError: (msg, site) => collector.captureError(turn, msg, site)
 *   // 结束后: const entries = collector.getEntries();
 */
export class SessionCollector {
	private knownMessageCount = 0;
	private entries: LogEntry[] = [];

	/** 从 onTurn 回调中捕获本轮新增消息 */
	captureNewMessages(turn: number, state: Readonly<AgentState>): void {
		const messages = state.messages;
		for (let i = this.knownMessageCount; i < messages.length; i++) {
			const msg = messages[i];
			this.entries.push({
				type: "message",
				message: msg,
				turn,
			} as MessageEntry);
		}
		this.knownMessageCount = messages.length;
	}

	/** 从 onToolCall 回调中捕获工具调用记录 */
	captureToolCall(turn: number, tc: any, result: ToolResult): void {
		this.entries.push({
			type: "tool_call",
			turn,
			toolCall: {
				type: tc.type,
				path: tc.path,
				command: tc.command,
				pattern: tc.pattern,
				content: tc.content,
			},
			result: {
				success: result.success,
				data: result.data,
				error: result.error,
				duration: result.duration,
			},
		} as ToolCallEntry);
	}

	/** 从 onError 回调中捕获错误记录 */
	captureError(turn: number, message: string, site: string): void {
		this.entries.push({
			type: "error",
			turn,
			site,
			message,
			recoverable: true,
		} as ErrorEntry);
	}

	/** 获取所有已收集的日志条目 */
	getEntries(): LogEntry[] {
		return [...this.entries];
	}

	/** 重置收集器（新会话前调用） */
	reset(): void {
		this.entries = [];
		this.knownMessageCount = 0;
	}
}
