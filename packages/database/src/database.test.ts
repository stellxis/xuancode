import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DatabasePool,
	MigrationManager,
	SessionStoreSQLite,
	createConnection,
} from "./index";

/** 迁移目录中的 SQL 文件数量（NNN_name.sql） */
function migrationFileCount(migrationsDir: string): number {
	return fs
		.readdirSync(migrationsDir)
		.filter((f) => /^\d{3}_[\w]+\.sql$/.test(f)).length;
}

describe("createConnection", () => {
	it("should create a database with WAL mode", () => {
		// WAL mode requires a file-based database (not :memory:)
		const dbPath = `${tmpdir()}/test-wal-${randomUUID()}.db`;
		const db = createConnection({ dbPath });
		const pragma = db.pragma("journal_mode", { simple: true }) as string;
		expect(pragma).toBe("wal");
		db.close();
	});

	it("should enable foreign keys", () => {
		const db = createConnection({ dbPath: ":memory:" });
		const pragma = db.pragma("foreign_keys", { simple: true });
		expect(pragma).toBe(1);
		db.close();
	});

	it("should set cache size", () => {
		const db = createConnection({ dbPath: ":memory:", cacheSize: 16000 });
		const pragma = db.pragma("cache_size", { simple: true });
		expect(pragma).toBe(-16000);
		db.close();
	});
});

describe("DatabasePool", () => {
	afterEach(() => {
		DatabasePool.reset();
	});

	it("should return the same instance", () => {
		const db1 = DatabasePool.getInstance({ dbPath: ":memory:" });
		const db2 = DatabasePool.getInstance({ dbPath: ":memory:" });
		expect(db1).toBe(db2);
		DatabasePool.close();
		DatabasePool.close();
	});

	it("should throw if no config on first call", () => {
		DatabasePool.reset();
		expect(() => DatabasePool.getInstance()).toThrow();
	});

	it("should handle close and reopen", () => {
		const db1 = DatabasePool.getInstance({ dbPath: ":memory:" });
		DatabasePool.close();
		const db2 = DatabasePool.getInstance({ dbPath: ":memory:" });
		expect(db2).not.toBe(db1);
		DatabasePool.close();
	});
});

describe("MigrationManager", () => {
	let db: Database.Database;
	let migrationsDir: string;

	beforeEach(() => {
		db = createConnection({ dbPath: ":memory:" });
		migrationsDir = `${__dirname}/migrations`;
	});

	afterEach(() => {
		db.close();
	});

	it("should apply migration 001_init", () => {
		const mgr = new MigrationManager(db, migrationsDir);
		mgr.migrate();

		// Check tables exist
		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			.all() as { name: string }[];
		const tableNames = tables.map((t) => t.name).sort();

		expect(tableNames).toContain("sessions");
		expect(tableNames).toContain("messages");
		expect(tableNames).toContain("tool_calls");
		expect(tableNames).toContain("errors");
		expect(tableNames).toContain("compactions");
		expect(tableNames).toContain("users");
		expect(tableNames).toContain("usage_records");
		expect(tableNames).toContain("daemon_tasks");
		expect(tableNames).toContain("_migrations");
		// 商业数据表（本地模式 SQLite 计费，与云端模式 PG 共存）
		expect(tableNames).toContain("orders");
		expect(tableNames).toContain("licenses");
		expect(tableNames).toContain("invoices");
	});

	it("should record migration in _migrations table", () => {
		const mgr = new MigrationManager(db, migrationsDir);
		mgr.migrate();

		const records = db
			.prepare("SELECT version, description FROM _migrations")
			.all() as any[];
		expect(records.length).toBe(migrationFileCount(migrationsDir));
		const init = records.find((r) => r.version === 1);
		expect(init).toBeDefined();
		expect(init?.description).toBe("init");
	});

	it("should be idempotent", () => {
		const mgr = new MigrationManager(db, migrationsDir);
		mgr.migrate();
		mgr.migrate(); // second call should not throw

		const records = db.prepare("SELECT version FROM _migrations").all();
		expect(records.length).toBe(migrationFileCount(migrationsDir));
	});

	it("should return migration status", () => {
		const mgr = new MigrationManager(db, migrationsDir);
		const status = mgr.getStatus();

		expect(status.length).toBe(migrationFileCount(migrationsDir));
		expect(status[0].version).toBe(1);
		expect(status[0].appliedAt).toBeNull();

		mgr.migrate();

		const statusAfter = mgr.getStatus();
		expect(statusAfter[0].appliedAt).not.toBeNull();
	});
});

describe("SessionStoreSQLite", () => {
	let db: Database.Database;
	let repo: SessionStoreSQLite;

	beforeEach(() => {
		db = createConnection({ dbPath: ":memory:" });
		const mgr = new MigrationManager(db, `${__dirname}/migrations`);
		mgr.migrate();
		repo = new SessionStoreSQLite(db);
	});

	afterEach(() => {
		db.close();
	});

	it("should import a session with meta entry", () => {
		const sessionId = "test-session-1";
		repo.importEntry(sessionId, {
			type: "session_meta",
			sessionId,
			createdAt: "2026-05-01T00:00:00.000Z",
			config: {
				workDir: "/test",
				maxTurns: 10,
				mode: "default",
				modelName: "test",
				modelProvider: "test",
			},
			userInput: "test input",
		});

		const sessions = repo.listSessions();
		expect(sessions.length).toBe(1);
		expect(sessions[0].id).toBe(sessionId);
		expect(sessions[0].user_input).toBe("test input");
	});

	it("should import messages", () => {
		const sessionId = "test-session-2";
		repo.importEntry(sessionId, {
			type: "session_meta",
			sessionId,
			createdAt: "2026-05-01T00:00:00.000Z",
			config: {
				workDir: "/test",
				maxTurns: 10,
				mode: "default",
				modelName: "test",
				modelProvider: "test",
			},
			userInput: "hi",
		});

		repo.importEntry(sessionId, {
			type: "message",
			turn: 0,
			message: { role: "user", content: "hi" },
		});

		repo.importEntry(sessionId, {
			type: "message",
			turn: 1,
			message: { role: "assistant", content: "hello" },
		});

		const detail = repo.getSessionDetail(sessionId);
		expect(detail).not.toBeNull();
		expect(detail?.messages.length).toBe(2);
		expect(detail?.messages[0].content).toBe("hi");
		expect(detail?.messages[1].content).toBe("hello");
	});

	it("should import tool calls", () => {
		const sessionId = "test-session-3";
		repo.importEntry(sessionId, {
			type: "session_meta",
			sessionId,
			createdAt: "2026-05-01T00:00:00.000Z",
			config: {
				workDir: "/test",
				maxTurns: 10,
				mode: "default",
				modelName: "test",
				modelProvider: "test",
			},
			userInput: "list files",
		});

		repo.importEntry(sessionId, {
			type: "tool_call",
			turn: 0,
			toolCall: { type: "list_dir", path: "." },
			result: { success: true, data: "file1.txt\nfile2.txt", duration: 5 },
		});

		const detail = repo.getSessionDetail(sessionId);
		expect(detail?.toolCalls.length).toBe(1);
		expect(detail?.toolCalls[0].tool_type).toBe("list_dir");
		expect(detail?.toolCalls[0].success).toBe(1);
	});

	it("should import errors", () => {
		const sessionId = "test-session-4";
		repo.importEntry(sessionId, {
			type: "session_meta",
			sessionId,
			createdAt: "2026-05-01T00:00:00.000Z",
			config: {
				workDir: "/test",
				maxTurns: 10,
				mode: "default",
				modelName: "test",
				modelProvider: "test",
			},
			userInput: "do something",
		});

		repo.importEntry(sessionId, {
			type: "error",
			turn: 0,
			site: "tool_executor",
			message: "Connection timeout",
			recoverable: true,
		});

		const detail = repo.getSessionDetail(sessionId);
		expect(detail?.errors.length).toBe(1);
		expect(detail?.errors[0].message).toBe("Connection timeout");
	});

	it("should handle session end update", () => {
		const sessionId = "test-session-5";
		repo.importEntry(sessionId, {
			type: "session_meta",
			sessionId,
			createdAt: "2026-05-01T00:00:00.000Z",
			config: {
				workDir: "/test",
				maxTurns: 10,
				mode: "default",
				modelName: "test",
				modelProvider: "test",
			},
			userInput: "hi",
		});

		repo.importEntry(sessionId, {
			type: "session_end",
			duration: 5000,
			turnCount: 5,
			toolCallCount: 3,
			errorCount: 1,
			stopReason: "no_tool_use",
			finalAnswer: "done",
			contextUsage: 100,
		});

		const sessions = repo.listSessions();
		expect(sessions[0].status).toBe("completed");
		expect(sessions[0].turn_count).toBe(5);
	});

	it("should delete session with cascade", () => {
		const sessionId = "test-session-6";
		repo.importEntry(sessionId, {
			type: "session_meta",
			sessionId,
			createdAt: "2026-05-01T00:00:00.000Z",
			config: {
				workDir: "/test",
				maxTurns: 10,
				mode: "default",
				modelName: "test",
				modelProvider: "test",
			},
			userInput: "hi",
		});
		repo.importEntry(sessionId, {
			type: "message",
			turn: 0,
			message: { role: "user", content: "hi" },
		});

		repo.deleteSession(sessionId);
		const detail = repo.getSessionDetail(sessionId);
		expect(detail).toBeNull();

		const msgCount = (
			db
				.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?")
				.get(sessionId) as any
		).c;
		expect(msgCount).toBe(0);
	});

	it("should handle batch import", () => {
		const sessionId = "test-session-7";
		repo.importEntries(sessionId, [
			{
				type: "session_meta",
				sessionId,
				createdAt: "2026-05-01T00:00:00.000Z",
				config: {
					workDir: "/test",
					maxTurns: 10,
					mode: "default",
					modelName: "test",
					modelProvider: "test",
				},
				userInput: "batch test",
			},
			{ type: "message", turn: 0, message: { role: "user", content: "msg1" } },
			{
				type: "message",
				turn: 1,
				message: { role: "assistant", content: "msg2" },
			},
			{
				type: "tool_call",
				turn: 0,
				toolCall: { type: "read_file", path: "test.txt" },
				result: { success: true, data: "content" },
			},
		]);

		const stats = repo.getStats();
		expect(stats.totalSessions).toBe(1);
		expect(stats.totalMessages).toBe(2);
		expect(stats.totalToolCalls).toBe(1);
	});

	it("should rebuild session", () => {
		const sessionId = "test-session-8";
		// First import
		repo.importEntry(sessionId, {
			type: "session_meta",
			sessionId,
			createdAt: "2026-05-01T00:00:00.000Z",
			config: {
				workDir: "/test",
				maxTurns: 10,
				mode: "default",
				modelName: "test",
				modelProvider: "test",
			},
			userInput: "rebuild test",
		});

		// Rebuild with new data
		repo.rebuildSession(sessionId, [
			{
				type: "session_meta",
				sessionId,
				createdAt: "2026-05-02T00:00:00.000Z",
				config: {
					workDir: "/new",
					maxTurns: 20,
					mode: "default",
					modelName: "test",
					modelProvider: "test",
				},
				userInput: "rebuilt input",
			},
		]);

		const sessions = repo.listSessions();
		expect(sessions.length).toBe(1);
		expect(sessions[0].user_input).toBe("rebuilt input");
	});

	it("should report correct stats", () => {
		const stats = repo.getStats();
		expect(stats.totalSessions).toBe(0);
		expect(stats.totalMessages).toBe(0);
		expect(stats.totalToolCalls).toBe(0);
		expect(stats.totalErrors).toBe(0);
	});
});
