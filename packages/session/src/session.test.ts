import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SessionManager, SessionStore } from "./index";

const TEST_DIR = path.join(process.cwd(), ".test-sessiontmp");

describe("SessionStore", () => {
	let store: SessionStore;

	beforeEach(() => {
		if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
		store = new SessionStore(TEST_DIR);
	});

	afterAll(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("should init and create directory", async () => {
		await store.init();
		expect(fs.existsSync(store.getSessionDir())).toBe(true);
	});

	it("should write meta and read it back", async () => {
		await store.init();
		await store.writeMeta(
			{
				workDir: "/test",
				mode: "default",
				maxTurns: 10,
				modelName: "deepseek",
				modelProvider: "deepseek",
			},
			"hello",
		);
		const entries = await store.readAll();
		expect(entries).toHaveLength(1);
		expect(entries[0].type).toBe("session_meta");
		if (entries[0].type === "session_meta") {
			expect(entries[0].config.workDir).toBe("/test");
			expect(entries[0].userInput).toBe("hello");
		}
	});

	it("should log and rebuild messages", async () => {
		await store.init();
		await store.logMessage({ role: "user", content: "hello" }, 1);
		await store.logMessage({ role: "assistant", content: "hi" }, 1);

		const messages = await store.rebuildMessages();
		expect(messages).toHaveLength(2);
		expect(messages[0].content).toBe("hello");
		expect(messages[1].content).toBe("hi");
	});

	it("should log tool calls and get audit trail", async () => {
		await store.init();
		await store.logToolCall(
			1,
			{ type: "list_dir", path: "." },
			{ success: true, data: "src\n", duration: 5 },
		);

		const trail = await store.getAuditTrail();
		expect(trail).toHaveLength(1);
		expect(trail[0].toolCall.type).toBe("list_dir");
		expect(trail[0].result.success).toBe(true);
	});

	it("should log errors", async () => {
		await store.init();
		await store.logError(1, "tool_execution", "command not found", true);

		const entries = await store.readAll();
		const errors = entries.filter((e) => e.type === "error");
		expect(errors).toHaveLength(1);
		if (errors[0].type === "error") {
			expect(errors[0].recoverable).toBe(true);
		}
	});

	it("should log compact events", async () => {
		await store.init();
		await store.logCompact(5, 3, 100, 30);

		const entries = await store.readAll();
		const compacts = entries.filter((e) => e.type === "compact");
		expect(compacts).toHaveLength(1);
	});

	it("should write end and get summary", async () => {
		await store.init();
		await store.writeMeta(
			{
				workDir: "/test",
				mode: "default",
				maxTurns: 15,
				modelName: "deepseek",
				modelProvider: "deepseek",
			},
			"hello",
		);
		await store.logMessage({ role: "user", content: "hello" }, 1);
		await store.logMessage({ role: "assistant", content: "world" }, 1);
		await store.logToolCall(
			1,
			{ type: "read_file", path: "test.ts" },
			{ success: true, data: "content", duration: 3 },
		);
		await store.writeEnd({
			duration: 5000,
			turnCount: 1,
			toolCallCount: 1,
			errorCount: 0,
			stopReason: "success",
			finalAnswer: "done",
			contextUsage: 0.05,
		});

		const summary = await store.getSummary();
		expect(summary.meta).toBeTruthy();
		expect(summary.end).toBeTruthy();
		expect(summary.messageCount).toBe(2);
		expect(summary.toolCallCount).toBe(1);
		if (summary.end) {
			expect(summary.end.duration).toBe(5000);
			expect(summary.end.stopReason).toBe("success");
		}
	});

	it("should handle empty store", async () => {
		await store.init();
		const messages = await store.rebuildMessages();
		expect(messages).toHaveLength(0);
		const trail = await store.getAuditTrail();
		expect(trail).toHaveLength(0);
	});

	it("should use default maxLogSize of 10MB", () => {
		const store = new SessionStore(TEST_DIR);
		expect((store as any).maxLogSize).toBe(10 * 1024 * 1024);
	});

	it("should return session id and log path", async () => {
		await store.init();
		expect(store.getSessionId()).toBeTruthy();
		expect(store.getLogPath()).toContain(".jsonl");
		expect(store.getSessionDir()).toBe(TEST_DIR);
	});

	it("should handle reading non-existent log file", async () => {
		const entries = await store.readAll();
		expect(entries).toEqual([]);
	});

	it("should write multiple entries in order", async () => {
		await store.init();
		await store.writeMeta(
			{
				workDir: "/test",
				mode: "default",
				maxTurns: 10,
				modelName: "deepseek",
				modelProvider: "deepseek",
			},
			"multi",
		);
		await store.logMessage({ role: "user", content: "first" }, 1);
		await store.logMessage({ role: "assistant", content: "second" }, 1);
		await store.logError(1, "test", "warning", false);
		await store.logCompact(1, 2, 10, 5);

		const entries = await store.readAll();
		expect(entries.length).toBe(5);
		expect(entries[0].type).toBe("session_meta");
		expect(entries[1].type).toBe("message");
		expect(entries[2].type).toBe("message");
		expect(entries[3].type).toBe("error");
		expect(entries[4].type).toBe("compact");
	});

	it("should handle unrecoverable errors", async () => {
		await store.init();
		await store.logError(1, "api", "invalid key", false);
		await store.logError(2, "tool", "timeout", true);

		const entries = await store.readAll();
		const errors = entries.filter((e) => e.type === "error");
		expect(errors.length).toBe(2);
	});

	it("should write after rotation", async () => {
		const smallStore = new SessionStore({
			sessionDir: TEST_DIR,
			maxLogSize: 1,
		});
		await smallStore.init();
		// Write enough to trigger rotation, then write again
		for (let i = 0; i < 5; i++) {
			await smallStore.logMessage({ role: "user", content: `msg-${i}` }, i);
		}

		const all = await smallStore.readAll();
		const msgs = all.filter((e) => e.type === "message");
		expect(msgs.length).toBe(5);
	});

	it("should rotate log file when exceeding maxLogSize", async () => {
		const smallStore = new SessionStore({
			sessionDir: TEST_DIR,
			maxLogSize: 1,
		});
		await smallStore.init();
		await smallStore.logMessage({ role: "user", content: "a" }, 1);
		await smallStore.logMessage({ role: "user", content: "b" }, 1);

		const files = fs.readdirSync(TEST_DIR);
		const rotated = files.filter((f) => f.endsWith(".rotated"));
		expect(rotated.length).toBeGreaterThanOrEqual(1);
	});

	it("should read all entries across rotated and current files", async () => {
		const rotDir = path.join(TEST_DIR, "rot-read");
		fs.mkdirSync(rotDir, { recursive: true });
		const store = new SessionStore({ sessionDir: rotDir, maxLogSize: 1 });
		await store.init();
		await store.logMessage({ role: "user", content: "A" }, 1);
		await store.logMessage({ role: "user", content: "B" }, 1);

		const all = await store.readAll();
		const messages = all.filter((e) => e.type === "message");
		expect(messages).toHaveLength(2);

		fs.rmSync(rotDir, { recursive: true, force: true });
	});
});

describe("SessionManager", () => {
	const mgr = new SessionManager(TEST_DIR);

	afterAll(() => {
		fs.rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("should create sessions", async () => {
		const session = await mgr.createSession(
			{
				workDir: "/test",
				mode: "default",
				maxTurns: 15,
				modelName: "deepseek",
				modelProvider: "deepseek",
			},
			"test input",
		);
		expect(session.getSessionId()).toBeTruthy();
		expect(fs.existsSync(session.getLogPath())).toBe(true);
	});

	it("should list sessions", async () => {
		const sessions = await mgr.listSessions();
		expect(sessions.length).toBeGreaterThanOrEqual(1);
		expect(sessions[0].sessionId).toBeTruthy();
	});

	it("should load existing session", async () => {
		const session = await mgr.createSession(
			{
				workDir: "/test",
				mode: "default",
				maxTurns: 15,
				modelName: "deepseek",
				modelProvider: "deepseek",
			},
			"load test",
		);
		const sessionId = session.getSessionId();
		await session.logMessage({ role: "user", content: "persist test" }, 1);

		const loaded = await mgr.loadSession(sessionId);
		const messages = await loaded.rebuildMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].content).toBe("persist test");
	});

	it("should prune old sessions by age", async () => {
		const ttlDir = path.join(TEST_DIR, "ttl-old");
		fs.mkdirSync(ttlDir, { recursive: true });
		const mgr = new SessionManager(ttlDir);
		const session = await mgr.createSession({}, "old test");
		const logPath = session.getLogPath();
		const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
		fs.utimesSync(logPath, oldDate, oldDate);

		const deleted = await mgr.pruneSessions(30);
		expect(deleted).toBe(1);
		expect(fs.existsSync(logPath)).toBe(false);
		fs.rmSync(ttlDir, { recursive: true, force: true });
	});

	it("should keep recent sessions during prune", async () => {
		const keepDir = path.join(TEST_DIR, "ttl-keep");
		fs.mkdirSync(keepDir, { recursive: true });
		const mgr = new SessionManager(keepDir);
		const session = await mgr.createSession({}, "keep test");
		const logPath = session.getLogPath();

		const deleted = await mgr.pruneSessions(30);
		expect(deleted).toBe(0);
		expect(fs.existsSync(logPath)).toBe(true);
		fs.rmSync(keepDir, { recursive: true, force: true });
	});
});
