import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "@xuancode/session";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MigrationManager,
	SessionStoreSQLite,
	createConnection,
} from "./index";

/**
 * Dual-write consistency test
 *
 * Simulates Phase 1 migration: writing to both JSONL (SessionStore)
 * and SQLite (SessionStoreSQLite), then verifying both stores
 * contain the same data.
 */
describe("Dual-write consistency", () => {
	let db: Database.Database;
	let sqliteRepo: SessionStoreSQLite;
	let sessionDir: string;

	beforeEach(async () => {
		db = createConnection({ dbPath: ":memory:" });
		const mgr = new MigrationManager(db, `${__dirname}/migrations`);
		mgr.migrate();
		sqliteRepo = new SessionStoreSQLite(db);

		sessionDir = path.join(tmpdir(), `dual-write-test-${randomUUID()}`);
		await fs.promises.mkdir(sessionDir, { recursive: true });
	});

	afterEach(async () => {
		db.close();
		// Cleanup temp files
		try {
			const files = await fs.promises.readdir(sessionDir);
			for (const f of files) {
				await fs.promises.unlink(path.join(sessionDir, f));
			}
			await fs.promises.rmdir(sessionDir);
		} catch {
			/* ok */
		}
	});

	/** 模拟双写：往 JSONL 和 SQLite 同时写入相同数据 */
	async function dualWrite(
		store: SessionStore,
		sessionId: string,
		entries: Array<{ type: string; [key: string]: any }>,
	): Promise<void> {
		for (const entry of entries) {
			// Write to JSONL
			await store.append(entry as any);
			// Write to SQLite
			sqliteRepo.importEntry(sessionId, entry as any);
		}
	}

	it("should produce same message count in both stores", async () => {
		const sessionId = `dual-test-${randomUUID()}`;
		const store = new SessionStore({ sessionDir, maxLogSize: 10485760 });
		// Override sessionId to match
		(store as any).sessionId = sessionId;
		(store as any).logPath = path.join(sessionDir, `${sessionId}.jsonl`);
		await store.init();

		await dualWrite(store, sessionId, [
			{
				type: "session_meta",
				sessionId,
				createdAt: new Date().toISOString(),
				config: {
					workDir: "/test",
					maxTurns: 10,
					mode: "default",
					modelName: "m",
					modelProvider: "p",
				},
				userInput: "dual write test",
			},
			{ type: "message", turn: 0, message: { role: "user", content: "hello" } },
			{
				type: "message",
				turn: 1,
				message: { role: "assistant", content: "world" },
			},
		]);

		// Read from JSONL
		const jsonlEntries = await store.readAll();
		const jsonlMsgCount = jsonlEntries.filter(
			(e) => e.type === "message",
		).length;

		// Read from SQLite
		const detail = sqliteRepo.getSessionDetail(sessionId);
		const sqliteMsgCount = detail?.messages.length ?? 0;

		expect(jsonlMsgCount).toBe(2);
		expect(sqliteMsgCount).toBe(2);
		expect(jsonlMsgCount).toBe(sqliteMsgCount);
	});

	it("should produce same tool call count in both stores", async () => {
		const sessionId = `dual-tool-${randomUUID()}`;
		const store = new SessionStore({ sessionDir, maxLogSize: 10485760 });
		(store as any).sessionId = sessionId;
		(store as any).logPath = path.join(sessionDir, `${sessionId}.jsonl`);
		await store.init();

		await dualWrite(store, sessionId, [
			{
				type: "session_meta",
				sessionId,
				createdAt: new Date().toISOString(),
				config: {
					workDir: "/test",
					maxTurns: 10,
					mode: "default",
					modelName: "m",
					modelProvider: "p",
				},
				userInput: "tool test",
			},
			{
				type: "tool_call",
				turn: 0,
				toolCall: { type: "list_dir", path: "." },
				result: { success: true, data: "files", duration: 5 },
			},
			{
				type: "tool_call",
				turn: 1,
				toolCall: { type: "read_file", path: "test.txt" },
				result: { success: false, error: "not found", duration: 2 },
			},
		]);

		const jsonlEntries = await store.readAll();
		const jsonlTcCount = jsonlEntries.filter(
			(e) => e.type === "tool_call",
		).length;

		const detail = sqliteRepo.getSessionDetail(sessionId);
		const sqliteTcCount = detail?.toolCalls.length ?? 0;

		expect(jsonlTcCount).toBe(2);
		expect(sqliteTcCount).toBe(2);
	});

	it("should produce same summary in both stores", async () => {
		const sessionId = `dual-summary-${randomUUID()}`;
		const store = new SessionStore({ sessionDir, maxLogSize: 10485760 });
		(store as any).sessionId = sessionId;
		(store as any).logPath = path.join(sessionDir, `${sessionId}.jsonl`);
		await store.init();

		await dualWrite(store, sessionId, [
			{
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
				userInput: "summary test",
			},
			{ type: "message", turn: 0, message: { role: "user", content: "hi" } },
			{
				type: "tool_call",
				turn: 0,
				toolCall: { type: "grep", pattern: "test" },
				result: { success: true, data: "result" },
			},
			{
				type: "error",
				turn: 0,
				site: "executor",
				message: "warn",
				recoverable: true,
			},
			{
				type: "session_end",
				duration: 1000,
				turnCount: 1,
				toolCallCount: 1,
				errorCount: 1,
				stopReason: "no_tool_use",
				finalAnswer: "done",
				contextUsage: 50,
			},
		]);

		// JSONL summary
		const jsonlSummary = await store.getSummary();

		// SQLite stats
		const sqliteDetail = sqliteRepo.getSessionDetail(sessionId);

		expect(jsonlSummary.messageCount).toBe(1);
		expect(jsonlSummary.toolCallCount).toBe(1);
		expect(jsonlSummary.errorCount).toBe(1);
		expect(sqliteDetail).not.toBeNull();
		expect(sqliteDetail?.messages.length).toBe(jsonlSummary.messageCount);
		expect(sqliteDetail?.toolCalls.length).toBe(jsonlSummary.toolCallCount);
		expect(sqliteDetail?.errors.length).toBe(jsonlSummary.errorCount);
	});

	it("should handle dual-write of empty session", async () => {
		const sessionId = `dual-empty-${randomUUID()}`;
		const store = new SessionStore({ sessionDir, maxLogSize: 10485760 });
		(store as any).sessionId = sessionId;
		(store as any).logPath = path.join(sessionDir, `${sessionId}.jsonl`);
		await store.init();

		// Only write meta, nothing else
		await dualWrite(store, sessionId, [
			{
				type: "session_meta",
				sessionId,
				createdAt: new Date().toISOString(),
				config: {
					workDir: "/test",
					maxTurns: 10,
					mode: "default",
					modelName: "m",
					modelProvider: "p",
				},
				userInput: "empty",
			},
		]);

		const jsonlEntries = await store.readAll();
		expect(jsonlEntries.length).toBe(1);

		const detail = sqliteRepo.getSessionDetail(sessionId);
		expect(detail).not.toBeNull();
		expect(detail?.messages.length).toBe(0);
	});

	it("should handle dual-write with compact entries", async () => {
		const sessionId = `dual-compact-${randomUUID()}`;
		const store = new SessionStore({ sessionDir, maxLogSize: 10485760 });
		(store as any).sessionId = sessionId;
		(store as any).logPath = path.join(sessionDir, `${sessionId}.jsonl`);
		await store.init();

		await dualWrite(store, sessionId, [
			{
				type: "session_meta",
				sessionId,
				createdAt: new Date().toISOString(),
				config: {
					workDir: "/test",
					maxTurns: 10,
					mode: "default",
					modelName: "m",
					modelProvider: "p",
				},
				userInput: "compact",
			},
			{ type: "message", turn: 0, message: { role: "user", content: "a" } },
			{
				type: "message",
				turn: 1,
				message: { role: "assistant", content: "b" },
			},
			{
				type: "compact",
				turn: 1,
				level: 2,
				beforeCount: 5,
				afterCount: 2,
			},
		]);

		const jsonlEntries = await store.readAll();
		const jsonlCompactCount = jsonlEntries.filter(
			(e) => e.type === "compact",
		).length;
		expect(jsonlCompactCount).toBe(1);

		const detail = sqliteRepo.getSessionDetail(sessionId);
		expect(detail).not.toBeNull();
		expect(detail?.messages.length).toBe(2);
	});

	it("should handle sequential dual-write of multiple sessions", async () => {
		for (let i = 0; i < 3; i++) {
			const sid = `dual-seq-${i}-${randomUUID()}`;
			const store = new SessionStore({ sessionDir, maxLogSize: 10485760 });
			(store as any).sessionId = sid;
			(store as any).logPath = path.join(sessionDir, `${sid}.jsonl`);
			await store.init();

			await dualWrite(store, sid, [
				{
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
				},
				{
					type: "message",
					turn: 0,
					message: { role: "user", content: `msg-${i}` },
				},
			]);
		}

		const stats = sqliteRepo.getStats();
		expect(stats.totalSessions).toBe(3);
		expect(stats.totalMessages).toBe(3);
	});

	it("should handle dual-write with real-world mixed entries", async () => {
		const sessionId = `dual-real-${randomUUID()}`;
		const store = new SessionStore({ sessionDir, maxLogSize: 10485760 });
		(store as any).sessionId = sessionId;
		(store as any).logPath = path.join(sessionDir, `${sessionId}.jsonl`);
		await store.init();

		await dualWrite(store, sessionId, [
			{
				type: "session_meta",
				sessionId,
				createdAt: new Date().toISOString(),
				config: {
					workDir: "/project",
					maxTurns: 50,
					mode: "default",
					modelName: "deepseek-v4-flash",
					modelProvider: "deepseek",
				},
				userInput: "帮我优化代码",
			},
			{
				type: "message",
				turn: 0,
				message: { role: "user", content: "帮我优化代码" },
			},
			{
				type: "message",
				turn: 0,
				message: { role: "assistant", content: "好的，让我先查看代码" },
			},
			{
				type: "tool_call",
				turn: 0,
				toolCall: { type: "read_file", path: "src/index.ts" },
				result: { success: true, data: "code...", duration: 50 },
			},
			{
				type: "message",
				turn: 1,
				message: { role: "user", content: "代码没问题" },
			},
			{
				type: "tool_call",
				turn: 1,
				toolCall: { type: "edit_file", path: "src/index.ts" },
				result: { success: true, data: "edited", duration: 100 },
			},
			{
				type: "error",
				turn: 1,
				site: "tool_executor",
				message: "timeout warning",
				recoverable: true,
			},
			{ type: "compact", turn: 1, level: 1, beforeCount: 20, afterCount: 10 },
			{
				type: "session_end",
				duration: 30000,
				turnCount: 2,
				toolCallCount: 2,
				errorCount: 1,
				stopReason: "no_tool_use",
				finalAnswer: "完成优化",
				contextUsage: 200,
			},
		]);

		const jsonlEntries = await store.readAll();
		const jsonlSummary = await store.getSummary();
		const sqliteDetail = sqliteRepo.getSessionDetail(sessionId);

		expect(jsonlSummary.messageCount).toBe(3);
		expect(jsonlSummary.toolCallCount).toBe(2);
		expect(jsonlSummary.errorCount).toBe(1);

		expect(sqliteDetail?.messages.length).toBe(3);
		expect(sqliteDetail?.toolCalls.length).toBe(2);
		expect(sqliteDetail?.errors.length).toBe(1);

		// Verify specific content matches
		expect(
			jsonlEntries.some(
				(e) =>
					e.type === "message" && (e as any).message.content === "帮我优化代码",
			),
		).toBe(true);
		expect(
			sqliteDetail?.messages.some((m: any) => m.content === "帮我优化代码"),
		).toBe(true);
	});
});
