import {
	buildCompactedMessages,
	generateCompactSummary,
} from "@xuancode/context";
import type {
	AgentState,
	Message,
	ToolCall,
	ToolResult,
} from "@xuancode/types";
import { StopReason } from "@xuancode/types";

/**
 * Immutable state manager with snapshot rollback, event tracking, and budget management
 */
export class StateManager {
	private state: AgentState;
	private snapshots: AgentState[] = [];
	private readonly MAX_SNAPSHOTS = 10;
	private listeners: Map<string, Array<(data: any) => void>> = new Map();

	constructor(initial: Partial<AgentState> = {}) {
		this.state = {
			messages: [],
			turnCount: 0,
			maxTurns: 50,
			startTime: Date.now(),
			errorHistory: [],
			contextBudget: 100000,
			maxContextBudget: 200000,
			consecutiveErrors: 0,
			...initial,
		};
	}

	getState(): Readonly<AgentState> {
		return this.state;
	}

	snapshot(): void {
		this.snapshots.push(JSON.parse(JSON.stringify(this.state)));
		if (this.snapshots.length > this.MAX_SNAPSHOTS) {
			this.snapshots.shift();
		}
	}

	rollback(): boolean {
		const snap = this.snapshots.pop();
		if (!snap) return false;
		this.state = snap;
		this.emit("rollback", { turn: this.state.turnCount });
		return true;
	}

	addMessage(msg: Message): void {
		this.state.messages.push(msg);
		this.emit("message", { role: msg.role, length: msg.content.length });
	}

	/** 滑动窗口压缩：早期消息摘要化，保留最近 N 轮完整 */
	compress(): void {
		const KEEP_LATEST = 6;
		if (this.state.turnCount <= 15) return;

		const msgs = this.state.messages;
		let userCount = 0;
		let splitIdx = msgs.length;
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (msgs[i].role === "user") userCount++;
			if (userCount > KEEP_LATEST) {
				splitIdx = i + 1;
				break;
			}
		}

		const compressed: Message[] = [];
		for (let i = 0; i < splitIdx; i++) {
			const m = msgs[i];
			if (m.role === "user") {
				compressed.push(m);
			} else if (m.content.length > 200) {
				compressed.push({
					...m,
					content: `${m.content.slice(0, 200)}...(摘要)`,
				});
			} else {
				compressed.push(m);
			}
		}
		for (let i = splitIdx; i < msgs.length; i++) compressed.push(msgs[i]);

		this.state.messages = compressed;
		this.resetBudget();
		this.emit("compress", {
			before: msgs.length,
			after: compressed.length,
			turn: this.state.turnCount,
		});
	}

	/** 语义压缩（AUTO_COMPACT 级）：早期消息生成真实摘要替代 200 字截断，
	 *  头部注入项目状态摘要保住任务目标/改动文件/工作流计划，保留最近 N 轮完整。
	 *  摘要失败时回退到 compress() 滑动窗口截断，不中断任务。 */
	compressWithSummary(checkpointSummary?: string): void {
		const KEEP_LATEST = 6;
		if (this.state.turnCount <= 15) return;

		const msgs = this.state.messages;
		let userCount = 0;
		let splitIdx = msgs.length;
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (msgs[i].role === "user") userCount++;
			if (userCount > KEEP_LATEST) {
				splitIdx = i + 1;
				break;
			}
		}
		if (splitIdx <= 0) return;

		const oldMsgs = msgs.slice(0, splitIdx);
		const recentMsgs = msgs.slice(splitIdx);

		try {
			const summary = generateCompactSummary(oldMsgs);
			const compacted = buildCompactedMessages(summary, recentMsgs);
			if (checkpointSummary) {
				const head = compacted[0];
				compacted[0] = {
					...head,
					content: `[项目状态]\n${checkpointSummary}\n\n${head.content}`,
				};
			}
			this.state.messages = compacted;
		} catch {
			this.compress();
			return;
		}

		this.resetBudget();
		this.emit("compress", {
			before: msgs.length,
			after: this.state.messages.length,
			turn: this.state.turnCount,
			level: "auto_compact",
		});
	}

	/** Replace all messages (used after compression) */
	replaceMessages(messages: Message[]): void {
		this.state.messages = messages;
		this.emit("compress", { count: messages.length });
	}

	/** Reset context budget based on current total chars (call after compression) */
	resetBudget(): void {
		const totalChars = this.state.messages.reduce(
			(sum, m) => sum + m.content.length,
			0,
		);
		this.state.contextBudget = Math.max(
			0,
			this.state.maxContextBudget - totalChars,
		);
	}

	incrementTurn(): void {
		this.state.turnCount++;
		this.emit("turn", { turn: this.state.turnCount });
	}

	/** 自动续跑：追加轮次预算。不复位 turnCount，轮次保持单调递增。 */
	extendTurns(extra: number): void {
		this.state.maxTurns += extra;
		this.emit("extendTurns", { maxTurns: this.state.maxTurns });
	}

	setStopReason(reason: NonNullable<AgentState["stopReason"]>): void {
		this.state.stopReason = reason;
	}

	setFinalAnswer(answer: string): void {
		this.state.finalAnswer = answer;
	}

	setError(error: Error): void {
		this.state.error = error;
		this.addError(error.message, true);
	}

	addError(message: string, recoverable: boolean): void {
		this.state.errorHistory.push({
			turn: this.state.turnCount,
			message,
			recoverable,
		});
		this.state.consecutiveErrors = recoverable
			? this.state.consecutiveErrors + 1
			: 0;
		this.emit("error", { turn: this.state.turnCount, message, recoverable });
	}

	setLastToolCall(tc: ToolCall): void {
		this.state.lastToolCall = tc;
	}

	setLastToolResult(tr: ToolResult): void {
		this.state.lastToolResult = tr;
	}

	resetConsecutiveErrors(): void {
		this.state.consecutiveErrors = 0;
	}

	consumeBudget(amount: number): boolean {
		this.state.contextBudget -= amount;
		if (this.state.contextBudget <= 0) {
			this.state.stopReason = StopReason.CONTEXT_OVERFLOW;
			return false;
		}
		return true;
	}

	getContextUsage(): number {
		const totalChars = this.state.messages.reduce(
			(sum, m) => sum + m.content.length,
			0,
		);
		return Math.round((totalChars / this.state.maxContextBudget) * 100);
	}

	// Simple event system
	on(event: string, handler: (data: any) => void): void {
		if (!this.listeners.has(event)) this.listeners.set(event, []);
		this.listeners.get(event)?.push(handler);
	}

	private emit(event: string, data: any): void {
		this.listeners.get(event)?.forEach((h) => h(data));
	}
}
