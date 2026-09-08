import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type SessionRecord,
	buildConversationSummarySimple,
	createSessionStore,
} from "./session";

let tmpDir: string;
let sessionFile: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xuancode-session-test-"));
	sessionFile = path.join(tmpDir, ".xuancode", "sessions.jsonl");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
	return {
		timestamp: 1700000000000,
		userInput: "测试输入",
		finalAnswer: "测试回答",
		turnCount: 1,
		toolCallCount: 0,
		...overrides,
	};
}

describe("createSessionStore", () => {
	it("saveSession 自动创建目录并追加 JSONL", () => {
		const store = createSessionStore(sessionFile);
		store.saveSession(record());
		store.saveSession(record({ userInput: "第二条" }));

		const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).userInput).toBe("测试输入");
		expect(JSON.parse(lines[1]).userInput).toBe("第二条");
	});

	it("loadLastSession 文件不存在 → null", () => {
		const store = createSessionStore(sessionFile);
		expect(store.loadLastSession()).toBeNull();
	});

	it("loadLastSession 只取最近 3 条并按 用户:/玄码: 格式拼接", () => {
		const store = createSessionStore(sessionFile);
		for (let i = 1; i <= 5; i++) {
			store.saveSession(
				record({ userInput: `问题${i}`, finalAnswer: `回答${i}` }),
			);
		}
		const loaded = store.loadLastSession()!;
		expect(loaded).not.toContain("问题1");
		expect(loaded).not.toContain("问题2");
		expect(loaded).toContain("问题3");
		expect(loaded).toContain("用户: 问题5");
		expect(loaded).toContain("玄码: 回答5");
		expect(loaded.split("\n\n")).toHaveLength(3);
	});

	it("loadLastSession 对 finalAnswer 截断到 500 字符", () => {
		const store = createSessionStore(sessionFile);
		store.saveSession(record({ finalAnswer: "x".repeat(600) }));
		const loaded = store.loadLastSession()!;
		expect(loaded).toContain("x".repeat(500));
		expect(loaded).not.toContain("x".repeat(501));
	});

	it("clearSessions 删除会话文件，loadLastSession 回到 null", () => {
		const store = createSessionStore(sessionFile);
		store.saveSession(record());
		expect(fs.existsSync(sessionFile)).toBe(true);
		store.clearSessions();
		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(store.loadLastSession()).toBeNull();
	});

	it("clearSessions 文件不存在时不抛错", () => {
		const store = createSessionStore(sessionFile);
		expect(() => store.clearSessions()).not.toThrow();
	});
});

describe("buildConversationSummarySimple", () => {
	it("空消息 → 空字符串", () => {
		expect(buildConversationSummarySimple([])).toBe("");
	});

	it("user/assistant 带角色前缀", () => {
		const summary = buildConversationSummarySimple([
			{ role: "user", content: "你好" } as any,
			{ role: "assistant", content: "你好！需要帮助吗" } as any,
		]);
		expect(summary).toBe("用户: 你好\n玄码: 你好！需要帮助吗");
	});

	it("过滤掉工具结果消息（user + 工具结果: 前缀）", () => {
		const summary = buildConversationSummarySimple([
			{ role: "user", content: "工具结果: {json}" } as any,
			{ role: "user", content: "真正的问题" } as any,
			{ role: "assistant", content: "回答" } as any,
		]);
		expect(summary).toBe("用户: 真正的问题\n玄码: 回答");
	});

	it("user 消息截断 500 字符，assistant 截断 1000 字符", () => {
		const summary = buildConversationSummarySimple([
			{ role: "user", content: "u".repeat(600) } as any,
			{ role: "assistant", content: "a".repeat(1100) } as any,
		]);
		expect(summary).toContain("u".repeat(500));
		expect(summary).not.toContain("u".repeat(501));
		expect(summary).toContain("a".repeat(1000));
		expect(summary).not.toContain("a".repeat(1001));
	});

	it("整体截断到 4000 字符", () => {
		const messages = Array.from({ length: 20 }, (_, i) => ({
			role: "assistant",
			content: `m${i}-`.padEnd(400, "x"),
		})) as any[];
		const summary = buildConversationSummarySimple(messages);
		expect(summary.length).toBeLessThanOrEqual(4000);
	});

	it("忽略未知 role", () => {
		const summary = buildConversationSummarySimple([
			{ role: "system", content: "system prompt" } as any,
			{ role: "user", content: "问题" } as any,
		]);
		expect(summary).toBe("用户: 问题");
	});
});
