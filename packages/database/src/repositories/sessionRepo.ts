import type { LogEntry, SessionEndEntry, SessionMeta } from "@xuancode/session";
import type Database from "better-sqlite3";
import {
	classifyEntries,
	entryToErrorRow,
	entryToMessageRow,
	entryToSessionRow,
	entryToToolCallRow,
} from "../utils";

/**
 * SessionStoreSQLite — SQLite 实现的会话存储
 *
 * 与 SessionStore（JSONL）实现相同的接口语义，用于双写模式。
 * 当前阶段作为基础设施，被 SessionStore 双写模式调用。
 */
export class SessionStoreSQLite {
	private db: Database.Database;
	private prepared: {
		insertSession: ReturnType<Database.Database["prepare"]>;
		updateSessionEnd: ReturnType<Database.Database["prepare"]>;
		insertMessage: ReturnType<Database.Database["prepare"]>;
		insertToolCall: ReturnType<Database.Database["prepare"]>;
		insertError: ReturnType<Database.Database["prepare"]>;
		insertCompact: ReturnType<Database.Database["prepare"]>;
		getSession: ReturnType<Database.Database["prepare"]>;
		listSessions: ReturnType<Database.Database["prepare"]>;
		getMessages: ReturnType<Database.Database["prepare"]>;
		getToolCalls: ReturnType<Database.Database["prepare"]>;
		getErrors: ReturnType<Database.Database["prepare"]>;
		deleteSession: ReturnType<Database.Database["prepare"]>;
	};

	constructor(db: Database.Database) {
		this.db = db;
		this.prepared = {
			insertSession: db.prepare(`
        INSERT INTO sessions (id, user_id, status, created_at, completed_at, user_input, config_json,
                              turn_count, tool_call_count, error_count, stop_reason, duration_ms,
                              final_answer, context_usage)
        VALUES (@id, @user_id, @status, @created_at, @completed_at, @user_input, @config_json,
                @turn_count, @tool_call_count, @error_count, @stop_reason, @duration_ms,
                @final_answer, @context_usage)
      `),
			updateSessionEnd: db.prepare(`
        UPDATE sessions SET status = 'completed', completed_at = @completed_at,
          turn_count = @turn_count, tool_call_count = @tool_call_count,
          error_count = @error_count, stop_reason = @stop_reason,
          duration_ms = @duration_ms, final_answer = @final_answer,
          context_usage = @context_usage
        WHERE id = @id
      `),
			insertMessage: db.prepare(`
        INSERT INTO messages (session_id, turn, role, content, tool_call_id, name, created_at)
        VALUES (@session_id, @turn, @role, @content, @tool_call_id, @name, @created_at)
      `),
			insertToolCall: db.prepare(`
        INSERT INTO tool_calls (session_id, turn, tool_type, args_json, success,
                                result_data, result_error, duration_ms, created_at)
        VALUES (@session_id, @turn, @tool_type, @args_json, @success,
                @result_data, @result_error, @duration_ms, @created_at)
      `),
			insertError: db.prepare(`
        INSERT INTO errors (session_id, turn, site, message, recoverable, created_at)
        VALUES (@session_id, @turn, @site, @message, @recoverable, @created_at)
      `),
			insertCompact: db.prepare(`
        INSERT INTO compactions (session_id, turn, level, before_count, after_count, created_at)
        VALUES (@session_id, @turn, @level, @before_count, @after_count, @created_at)
      `),
			getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
			listSessions: db.prepare(`
        SELECT id, created_at, status, turn_count, stop_reason, user_input
        FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?
      `),
			getMessages: db.prepare(
				"SELECT * FROM messages WHERE session_id = ? ORDER BY turn, id",
			),
			getToolCalls: db.prepare(
				"SELECT * FROM tool_calls WHERE session_id = ? ORDER BY turn, id",
			),
			getErrors: db.prepare(
				"SELECT * FROM errors WHERE session_id = ? ORDER BY turn, id",
			),
			deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
		};
	}

	/** 导入一条 JSONL LogEntry 到 SQLite */
	importEntry(sessionId: string, entry: LogEntry): void {
		switch (entry.type) {
			case "session_meta":
				this.prepared.insertSession.run(
					entryToSessionRow(entry, undefined, {
						userId: (entry as any).userId,
						workspaceId: (entry as any).workspaceId,
					}),
				);
				break;
			case "session_end":
				this.prepared.updateSessionEnd.run(
					entryToSessionRow(
						{
							type: "session_meta",
							sessionId,
							createdAt: "",
							config: {},
							userInput: "",
						} as SessionMeta,
						entry,
						{
							userId: (entry as any).userId,
							workspaceId: (entry as any).workspaceId,
						},
					),
				);
				break;
			case "message":
				this.prepared.insertMessage.run(entryToMessageRow(entry, sessionId));
				break;
			case "tool_call":
				this.prepared.insertToolCall.run(entryToToolCallRow(entry, sessionId));
				break;
			case "error":
				this.prepared.insertError.run(entryToErrorRow(entry, sessionId));
				break;
			case "compact":
				this.prepared.insertCompact.run({
					session_id: sessionId,
					turn: entry.turn,
					level: entry.level,
					before_count: entry.beforeCount,
					after_count: entry.afterCount,
					created_at: new Date().toISOString(),
				});
				break;
		}
	}

	/** 批量导入 LogEntry 数组（事务） */
	importEntries(sessionId: string, entries: LogEntry[]): void {
		const batch = this.db.transaction(() => {
			for (const entry of entries) {
				this.importEntry(sessionId, entry);
			}
		});
		batch();
	}

	/** 从 LogEntry 数组重建完整会话（先删后插，事务） */
	rebuildSession(sessionId: string, entries: LogEntry[]): void {
		const batch = this.db.transaction(() => {
			this.prepared.deleteSession.run(sessionId);
			this.importEntries(sessionId, entries);
		});
		batch();
	}

	/** 获取会话列表 */
	listSessions(
		limit = 50,
		offset = 0,
	): Array<{
		id: string;
		created_at: string;
		status: string;
		turn_count: number;
		stop_reason: string | null;
		user_input: string;
	}> {
		return (this.prepared.listSessions.all as any)(limit, offset) as any[];
	}

	/** 获取会话详情（含消息、工具调用、错误） */
	getSessionDetail(sessionId: string) {
		const session = this.prepared.getSession.get(sessionId) as any;
		if (!session) return null;

		return {
			...session,
			messages: this.prepared.getMessages.all(sessionId) as any[],
			toolCalls: this.prepared.getToolCalls.all(sessionId) as any[],
			errors: this.prepared.getErrors.all(sessionId) as any[],
		};
	}

	/** 删除会话（CASCADE 删除关联数据） */
	deleteSession(sessionId: string): void {
		this.prepared.deleteSession.run(sessionId);
	}

	/** 获取统计信息 */
	getStats(): {
		totalSessions: number;
		totalMessages: number;
		totalToolCalls: number;
		totalErrors: number;
	} {
		const sessionCount =
			(this.db.prepare("SELECT COUNT(*) as c FROM sessions").get() as any)?.c ??
			0;
		const msgCount =
			(this.db.prepare("SELECT COUNT(*) as c FROM messages").get() as any)?.c ??
			0;
		const tcCount =
			(this.db.prepare("SELECT COUNT(*) as c FROM tool_calls").get() as any)
				?.c ?? 0;
		const errCount =
			(this.db.prepare("SELECT COUNT(*) as c FROM errors").get() as any)?.c ??
			0;
		return {
			totalSessions: sessionCount,
			totalMessages: msgCount,
			totalToolCalls: tcCount,
			totalErrors: errCount,
		};
	}
}
