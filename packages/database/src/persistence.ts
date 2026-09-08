import path from "node:path";
import type { LogEntry } from "@xuancode/session";
import type Database from "better-sqlite3";
import { DatabasePool } from "./connection";
import { SessionStoreSQLite } from "./repositories/sessionRepo";
import { MigrationManager } from "./schema";

/**
 * SessionPersistence — 会话持久化服务
 *
 * 封装 SQLite 连接初始化、迁移、CRUD 操作。
 * CLI 和 Daemon 通过此服务写入/读取会话数据。
 */
export class SessionPersistence {
	private db: Database.Database | null = null;
	private store: SessionStoreSQLite | null = null;
	private dbPath: string;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
	}

	/** 初始化：建目录、开连接、跑迁移 */
	async initialize(): Promise<void> {
		const dir = path.dirname(this.dbPath);
		const fs = await import("node:fs/promises");
		await fs.mkdir(dir, { recursive: true });

		this.db = DatabasePool.getInstance({ dbPath: this.dbPath });
		const mm = new MigrationManager(this.db!);
		mm.migrate();
		this.store = new SessionStoreSQLite(this.db!);
	}

	/** 获取原始 Database 引用（供 SessionIndexer 等使用） */
	getDb(): Database.Database {
		if (!this.db) throw new Error("SessionPersistence not initialized");
		return this.db;
	}

	/** 关闭数据库连接 */
	close(): void {
		this.store = null;
		this.db = null;
		DatabasePool.close();
	}

	/** 保存完整会话的日志条目（可选记录 transcript 文件路径） */
	saveSession(
		sessionId: string,
		entries: LogEntry[],
		transcriptPath?: string,
	): void {
		if (!this.store) throw new Error("SessionPersistence not initialized");
		this.store.importEntries(sessionId, entries);
		if (transcriptPath) {
			this.store.setTranscriptPath(sessionId, transcriptPath);
		}
	}

	/** 重建会话（先删后插，用于重新导入） */
	rebuildSession(sessionId: string, entries: LogEntry[]): void {
		if (!this.store) throw new Error("SessionPersistence not initialized");
		this.store.rebuildSession(sessionId, entries);
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
		if (!this.store) throw new Error("SessionPersistence not initialized");
		return this.store.listSessions(limit, offset);
	}

	/** 获取会话详情（含消息、工具调用、错误） */
	getSessionDetail(sessionId: string) {
		if (!this.store) throw new Error("SessionPersistence not initialized");
		return this.store.getSessionDetail(sessionId);
	}

	/** 删除会话（级联删除关联数据） */
	deleteSession(sessionId: string): void {
		if (!this.store) throw new Error("SessionPersistence not initialized");
		this.store.deleteSession(sessionId);
	}

	/** 获取统计信息 */
	getStats(): {
		totalSessions: number;
		totalMessages: number;
		totalToolCalls: number;
		totalErrors: number;
	} {
		if (!this.store) throw new Error("SessionPersistence not initialized");
		return this.store.getStats();
	}
}
