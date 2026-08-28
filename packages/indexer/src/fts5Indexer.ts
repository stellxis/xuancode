import type Database from "better-sqlite3";

/**
 * SessionIndexer — FTS5 全文索引
 *
 * 在 `sessions.db` 中创建 `session_fts` 虚拟表，
 * 索引 messages.content 和 tool_calls.result_data，
 * 支持增量索引和搜索。
 */
export class SessionIndexer {
	private db: Database.Database;
	private initialized = false;

	constructor(db: Database.Database) {
		this.db = db;
	}

	/** 确保 FTS5 虚拟表存在 */
	ensureFTS(): void {
		if (this.initialized) return;
		this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
        session_id UNINDEXED,
        content,
        content_type,
        turn,
        tokenize='unicode61'
      )
    `);
		this.initialized = true;
	}

	/** 索引一个已完成会话的所有消息和工具结果 */
	indexSession(sessionId: string): void {
		this.ensureFTS();

		const messages = this.db
			.prepare(
				"SELECT id, turn, content FROM messages WHERE session_id = ? AND content IS NOT NULL AND content != ''",
			)
			.all(sessionId) as Array<{ id: number; turn: number; content: string }>;

		const toolCalls = this.db
			.prepare(
				"SELECT id, turn, result_data FROM tool_calls WHERE session_id = ? AND result_data IS NOT NULL AND result_data != ''",
			)
			.all(sessionId) as Array<{
			id: number;
			turn: number;
			result_data: string;
		}>;

		const insertMsg = this.db.prepare(
			"INSERT INTO session_fts (session_id, content, content_type, turn) VALUES (?, ?, 'message', ?)",
		);
		const insertTc = this.db.prepare(
			"INSERT INTO session_fts (session_id, content, content_type, turn) VALUES (?, ?, 'tool_result', ?)",
		);

		const batch = this.db.transaction(() => {
			// 清除旧索引
			this.db
				.prepare("DELETE FROM session_fts WHERE session_id = ?")
				.run(sessionId);

			for (const msg of messages) {
				insertMsg.run(sessionId, msg.content.slice(0, 3000), msg.turn);
			}
			for (const tc of toolCalls) {
				insertTc.run(sessionId, tc.result_data.slice(0, 3000), tc.turn);
			}
		});
		batch();
	}

	/** 重建全部索引 */
	rebuildAll(): void {
		this.ensureFTS();
		this.db.exec("DELETE FROM session_fts");

		const sessionIds = this.db
			.prepare("SELECT id FROM sessions")
			.all() as Array<{ id: string }>;
		for (const { id } of sessionIds) {
			this.indexSession(id);
		}
	}

	/** 搜索会话。返回按相关性排序的结果 */
	search(
		query: string,
		limit = 20,
	): Array<{
		session_id: string;
		snippet: string;
		content_type: string;
		turn: number;
		rank: number;
	}> {
		this.ensureFTS();
		if (!query.trim()) return [];

		try {
			const rows = this.db
				.prepare(`
        SELECT session_id, snippet(session_fts, 1, '<mark>', '</mark>', '...', 32) AS snippet,
               content_type, turn, rank
        FROM session_fts
        WHERE session_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `)
				.all(query, limit) as Array<{
				session_id: string;
				snippet: string;
				content_type: string;
				turn: number;
				rank: number;
			}>;
			return rows;
		} catch {
			// FTS5 query syntax error — fall back to LIKE
			const like = `%${query}%`;
			return this.db
				.prepare(`
        SELECT DISTINCT session_id, content AS snippet, content_type, turn, 0.0 AS rank
        FROM session_fts
        WHERE content LIKE ?
        LIMIT ?
      `)
				.all(like, limit) as any[];
		}
	}

	/** 删除一个会话的索引 */
	removeSession(sessionId: string): void {
		if (!this.initialized) return;
		this.db
			.prepare("DELETE FROM session_fts WHERE session_id = ?")
			.run(sessionId);
	}
}
