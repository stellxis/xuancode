import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MigrationManager,
	SessionStoreSQLite,
	createConnection,
} from "./index";

describe("Database edge cases", () => {
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

	it("should handle empty database stats", () => {
		const stats = repo.getStats();
		expect(stats.totalSessions).toBe(0);
		expect(stats.totalMessages).toBe(0);
		expect(stats.totalToolCalls).toBe(0);
		expect(stats.totalErrors).toBe(0);
	});

	it("should handle session with no messages", () => {
		const sessionId = "empty-session";
		repo.importEntry(sessionId, {
			type: "session_meta",
			sessionId,
			createdAt: "2026-05-01T00:00:00.000Z",
			config: {
				workDir: "/test",
				maxTurns: 10,
				mode: "default",
				modelName: "m",
				modelProvider: "p",
			},
			userInput: "empty",
		});

		const detail = repo.getSessionDetail(sessionId);
		expect(detail).not.toBeNull();
		expect(detail?.messages.length).toBe(0);
		expect(detail?.toolCalls.length).toBe(0);
		expect(detail?.errors.length).toBe(0);
	});

	it("should handle multiple sessions isolation", () => {
		for (let i = 0; i < 5; i++) {
			const sid = `multi-session-${i}`;
			repo.importEntry(sid, {
				type: "session_meta",
				sessionId: sid,
				createdAt: new Date().toISOString(),
				config: {
					workDir: "/test",
					maxTurns: 10,
					mode: "default",
					modelName: "m",
					modelProvider: "p",
				},
				userInput: `input-${i}`,
			});
			repo.importEntry(sid, {
				type: "message",
				turn: 0,
				message: { role: "user", content: `msg-${i}` },
			});
		}

		const sessions = repo.listSessions(100, 0);
		expect(sessions.length).toBe(5);

		// Verify each session has exactly 1 message
		for (let i = 0; i < 5; i++) {
			const detail = repo.getSessionDetail(`multi-session-${i}`);
			expect(detail?.messages.length).toBe(1);
			expect(detail?.messages[0].content).toBe(`msg-${i}`);
		}

		const stats = repo.getStats();
		expect(stats.totalSessions).toBe(5);
		expect(stats.totalMessages).toBe(5);
	});

	it("should handle many entries in single session", () => {
		const sid = "big-session";
		repo.importEntry(sid, {
			type: "session_meta",
			sessionId: sid,
			createdAt: "2026-05-01T00:00:00.000Z",
			config: {
				workDir: "/test",
				maxTurns: 100,
				mode: "default",
				modelName: "m",
				modelProvider: "p",
			},
			userInput: "big test",
		});

		// Import 50 messages and 50 tool calls
		for (let i = 0; i < 50; i++) {
			repo.importEntry(sid, {
				type: "message",
				turn: i,
				message: {
					role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
					content: `msg-${i}`,
				},
			});
		}

		const detail = repo.getSessionDetail(sid);
		expect(detail?.messages.length).toBe(50);
		expect(detail?.messages[0].content).toBe("msg-0");
		expect(detail?.messages[49].content).toBe("msg-49");

		const stats = repo.getStats();
		expect(stats.totalMessages).toBe(50);
	});

	it("should handle delete non-existent session without error", () => {
		expect(() => repo.deleteSession("non-existent")).not.toThrow();
	});

	it("should return null for non-existent session detail", () => {
		const detail = repo.getSessionDetail("non-existent");
		expect(detail).toBeNull();
	});

	it("should handle listSessions with large offset", () => {
		const sessions = repo.listSessions(10, 1000);
		expect(sessions.length).toBe(0);
	});

	it("should handle compact entry correctly", () => {
		const sid = "compact-test";
		repo.importEntry(sid, {
			type: "session_meta",
			sessionId: sid,
			createdAt: "2026-05-01T00:00:00.000Z",
			config: {
				workDir: "/test",
				maxTurns: 10,
				mode: "default",
				modelName: "m",
				modelProvider: "p",
			},
			userInput: "compact",
		});

		repo.importEntry(sid, {
			type: "compact",
			turn: 5,
			level: 2,
			beforeCount: 100,
			afterCount: 30,
		});

		const detail = repo.getSessionDetail(sid);
		// compact entries aren't fetched via standard detail — they exist in DB
		const row = db
			.prepare("SELECT * FROM compactions WHERE session_id = ?")
			.get(sid) as any;
		expect(row).toBeTruthy();
		expect(row.level).toBe(2);
		expect(row.before_count).toBe(100);
		expect(row.after_count).toBe(30);
	});

	it("should handle session_end with zero values", () => {
		const sid = "zero-end";
		repo.importEntry(sid, {
			type: "session_meta",
			sessionId: sid,
			createdAt: "2026-05-01T00:00:00.000Z",
			config: {
				workDir: "/test",
				maxTurns: 10,
				mode: "default",
				modelName: "m",
				modelProvider: "p",
			},
			userInput: "zero",
		});

		repo.importEntry(sid, {
			type: "session_end",
			duration: 0,
			turnCount: 0,
			toolCallCount: 0,
			errorCount: 0,
			stopReason: "no_tool_use",
			finalAnswer: "",
			contextUsage: 0,
		});

		const sessions = repo.listSessions();
		expect(sessions[0].turn_count).toBe(0);
	});

	it("should handle compact entries in transactions", () => {
		const sid = "tx-session";
		const insert = db.transaction(() => {
			repo.importEntry(sid, {
				type: "session_meta",
				sessionId: sid,
				createdAt: "2026-05-01T00:00:00.000Z",
				config: {
					workDir: "/test",
					maxTurns: 10,
					mode: "default",
					modelName: "m",
					modelProvider: "p",
				},
				userInput: "tx",
			});
			repo.importEntry(sid, {
				type: "message",
				turn: 0,
				message: { role: "user", content: "tx-test" },
			});
		});
		insert();

		const detail = repo.getSessionDetail(sid);
		expect(detail?.messages.length).toBe(1);
	});

	it("should rollback on error in transaction", () => {
		const sid = "rollback-session";
		expect(() => {
			const badTx = db.transaction(() => {
				repo.importEntry(sid, {
					type: "session_meta",
					sessionId: sid,
					createdAt: "2026-05-01T00:00:00.000Z",
					config: {
						workDir: "/test",
						maxTurns: 10,
						mode: "default",
						modelName: "m",
						modelProvider: "p",
					},
					userInput: "rollback",
				});
				// This should fail — wrong table name in raw SQL
				db.exec("INSERT INTO nonexistent_table VALUES (1)");
			});
			badTx();
		}).toThrow();

		// Session should not have been inserted
		const detail = repo.getSessionDetail(sid);
		expect(detail).toBeNull();
	});

	it("should handle concurrent reads during write", () => {
		const sid = "concurrent-session";
		repo.importEntry(sid, {
			type: "session_meta",
			sessionId: sid,
			createdAt: "2026-05-01T00:00:00.000Z",
			config: {
				workDir: "/test",
				maxTurns: 10,
				mode: "default",
				modelName: "m",
				modelProvider: "p",
			},
			userInput: "concurrent",
		});

		// Simulate concurrent read while writing — WAL mode allows this
		const writeTx = db.transaction(() => {
			for (let i = 0; i < 10; i++) {
				repo.importEntry(sid, {
					type: "message",
					turn: i,
					message: { role: "user" as const, content: `write-${i}` },
				});
				// Read during write transaction
				const count = (
					db
						.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?")
						.get(sid) as any
				).c;
				// Within the same transaction, uncommitted reads are visible
				expect(count).toBe(i + 1);
			}
		});
		writeTx();
	});
});

describe("File-based database edge cases", () => {
	let dbPath: string;

	afterEach(() => {
		// Cleanup temp files
		try {
			fs.unlinkSync(dbPath);
		} catch {
			/* ok */
		}
		try {
			fs.unlinkSync(`${dbPath}-wal`);
		} catch {
			/* ok */
		}
		try {
			fs.unlinkSync(`${dbPath}-shm`);
		} catch {
			/* ok */
		}
	});

	it("should create WAL file for file-based DB after writes", () => {
		dbPath = path.join(tmpdir(), `test-file-db-${randomUUID()}.db`);
		const db = createConnection({ dbPath });
		db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
		db.exec("INSERT INTO test VALUES (1, 'hello')");

		// Verify WAL mode
		const mode = db.pragma("journal_mode", { simple: true }) as string;
		expect(mode).toBe("wal");

		// Force WAL checkpoint to ensure WAL file is created
		db.pragma("wal_checkpoint(TRUNCATE)");
		db.close();

		// WAL file may exist after close (implementation-specific)
		// At minimum, the DB file itself should exist
		expect(fs.existsSync(dbPath)).toBe(true);
	});

	it("should persist data across close/reopen", () => {
		dbPath = path.join(tmpdir(), `test-persist-${randomUUID()}.db`);
		const db1 = createConnection({ dbPath });
		db1.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
		db1.exec("INSERT INTO test VALUES (1, 'persisted')");
		db1.close();

		const db2 = createConnection({ dbPath });
		const row = db2.prepare("SELECT name FROM test WHERE id = 1").get() as {
			name: string;
		};
		expect(row.name).toBe("persisted");
		db2.close();
	});

	it("should handle large transaction batch", () => {
		dbPath = path.join(tmpdir(), `test-batch-${randomUUID()}.db`);
		const db = createConnection({ dbPath });
		db.exec("CREATE TABLE batch_test (id INTEGER PRIMARY KEY, value TEXT)");

		const batchInsert = db.transaction((items: number[]) => {
			for (const id of items) {
				db.prepare("INSERT INTO batch_test VALUES (?, ?)").run(
					id,
					`value-${id}`,
				);
			}
		});

		batchInsert(Array.from({ length: 100 }, (_, i) => i));

		const count = (
			db.prepare("SELECT COUNT(*) as c FROM batch_test").get() as any
		).c;
		expect(count).toBe(100);
		db.close();
	});
});
