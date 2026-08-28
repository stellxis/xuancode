import type { LogEntry, SessionEndEntry } from "@xuancode/session";
import { describe, expect, it } from "vitest";
import {
	classifyEntries,
	entryToErrorRow,
	entryToMessageRow,
	entryToSessionRow,
	entryToToolCallRow,
} from "./utils";

describe("entryToSessionRow", () => {
	const meta = {
		type: "session_meta" as const,
		sessionId: "test-123",
		createdAt: "2026-05-01T00:00:00.000Z",
		config: {
			workDir: "/test",
			maxTurns: 10,
			mode: "default" as const,
			modelName: "m",
			modelProvider: "p",
		},
		userInput: "hello",
	};

	it("should convert meta without end entry", () => {
		const row = entryToSessionRow(meta);
		expect(row.id).toBe("test-123");
		expect(row.status).toBe("active");
		expect(row.turn_count).toBe(0);
		expect(row.duration_ms).toBeNull();
	});

	it("should include end data when provided", () => {
		const end: SessionEndEntry = {
			type: "session_end",
			duration: 5000,
			turnCount: 10,
			toolCallCount: 5,
			errorCount: 2,
			stopReason: "no_tool_use",
			finalAnswer: "done",
			contextUsage: 100,
		};
		const row = entryToSessionRow(meta, end);
		expect(row.status).toBe("completed");
		expect(row.turn_count).toBe(10);
		expect(row.tool_call_count).toBe(5);
		expect(row.error_count).toBe(2);
		expect(row.stop_reason).toBe("no_tool_use");
		expect(row.duration_ms).toBe(5000);
		expect(row.final_answer).toBe("done");
		expect(row.context_usage).toBe(100);
	});

	it("should include user_id and workspace_id when provided", () => {
		const row = entryToSessionRow(meta, undefined, {
			userId: "user-1",
			workspaceId: "ws-1",
		});
		expect(row.user_id).toBe("user-1");
		expect(row.workspace_id).toBe("ws-1");
	});

	it("should set user_id and workspace_id to null when not provided", () => {
		const row = entryToSessionRow(meta);
		expect(row.user_id).toBeNull();
		expect(row.workspace_id).toBeNull();
	});

	it("should serialize config_json as string", () => {
		const row = entryToSessionRow(meta);
		expect(() => JSON.parse(row.config_json)).not.toThrow();
		const parsed = JSON.parse(row.config_json);
		expect(parsed.workDir).toBe("/test");
	});
});

describe("entryToMessageRow", () => {
	it("should convert user message", () => {
		const entry = {
			type: "message" as const,
			turn: 0,
			message: { role: "user" as const, content: "hello" },
		};
		const row = entryToMessageRow(entry, "session-1");
		expect(row.session_id).toBe("session-1");
		expect(row.turn).toBe(0);
		expect(row.role).toBe("user");
		expect(row.content).toBe("hello");
		expect(row.tool_call_id).toBeNull();
		expect(row.name).toBeNull();
	});

	it("should convert assistant message with tool_call_id", () => {
		const entry = {
			type: "message" as const,
			turn: 1,
			message: {
				role: "assistant" as const,
				content: "result",
				tool_call_id: "call_123",
				name: "list_dir",
			},
		};
		const row = entryToMessageRow(entry, "session-1");
		expect(row.role).toBe("assistant");
		expect(row.content).toBe("result");
		expect(row.tool_call_id).toBe("call_123");
		expect(row.name).toBe("list_dir");
	});

	it("should handle empty content", () => {
		const entry = {
			type: "message" as const,
			turn: 0,
			message: { role: "user" as const, content: "" },
		};
		const row = entryToMessageRow(entry, "s1");
		expect(row.content).toBe("");
	});
});

describe("entryToToolCallRow", () => {
	it("should convert successful tool call", () => {
		const entry = {
			type: "tool_call" as const,
			turn: 0,
			toolCall: { type: "list_dir", path: "." },
			result: { success: true, data: "file1.txt", duration: 10 },
		};
		const row = entryToToolCallRow(entry, "session-1");
		expect(row.tool_type).toBe("list_dir");
		expect(row.success).toBe(1);
		expect(row.result_data).toBe("file1.txt");
		expect(row.result_error).toBeNull();
		expect(row.duration_ms).toBe(10);
	});

	it("should convert failed tool call", () => {
		const entry = {
			type: "tool_call" as const,
			turn: 1,
			toolCall: { type: "read_file", path: "missing.txt" },
			result: { success: false, error: "File not found", duration: 5 },
		};
		const row = entryToToolCallRow(entry, "session-1");
		expect(row.success).toBe(0);
		expect(row.result_data).toBeNull();
		expect(row.result_error).toBe("File not found");
	});

	it("should serialize toolCall args as JSON", () => {
		const entry = {
			type: "tool_call" as const,
			turn: 0,
			toolCall: { type: "shell", command: "ls -la" },
			result: { success: true, data: "" },
		};
		const row = entryToToolCallRow(entry, "s1");
		expect(() => JSON.parse(row.args_json)).not.toThrow();
		const parsed = JSON.parse(row.args_json);
		expect(parsed.command).toBe("ls -la");
	});
});

describe("entryToErrorRow", () => {
	it("should convert recoverable error", () => {
		const row = entryToErrorRow(
			{
				type: "error",
				turn: 0,
				site: "tool_executor",
				message: "timeout",
				recoverable: true,
			},
			"session-1",
		);
		expect(row.site).toBe("tool_executor");
		expect(row.message).toBe("timeout");
		expect(row.recoverable).toBe(1);
	});

	it("should convert unrecoverable error", () => {
		const row = entryToErrorRow(
			{
				type: "error",
				turn: 1,
				site: "model_api",
				message: "invalid key",
				recoverable: false,
			},
			"session-1",
		);
		expect(row.recoverable).toBe(0);
	});
});

describe("classifyEntries", () => {
	it("should classify mixed entries correctly", () => {
		const entries: LogEntry[] = [
			{
				type: "session_meta",
				sessionId: "s1",
				createdAt: "",
				config: {
					workDir: "/",
					maxTurns: 10,
					mode: "default",
					modelName: "m",
					modelProvider: "p",
				},
				userInput: "hi",
			},
			{ type: "message", turn: 0, message: { role: "user", content: "hi" } },
			{
				type: "tool_call",
				turn: 0,
				toolCall: { type: "list_dir" },
				result: { success: true, data: "" },
			},
			{
				type: "error",
				turn: 0,
				site: "test",
				message: "err",
				recoverable: true,
			},
			{ type: "compact", turn: 0, level: 1, beforeCount: 10, afterCount: 5 },
			{
				type: "session_end",
				duration: 100,
				turnCount: 1,
				toolCallCount: 1,
				errorCount: 0,
				stopReason: "no_tool_use",
				finalAnswer: "done",
				contextUsage: 50,
			},
		];

		const classified = classifyEntries(entries);
		expect(classified.meta?.sessionId).toBe("s1");
		expect(classified.end?.turnCount).toBe(1);
		expect(classified.messages.length).toBe(1);
		expect(classified.toolCalls.length).toBe(1);
		expect(classified.errors.length).toBe(1);
		expect(classified.compactions.length).toBe(1);
	});

	it("should return undefined for missing types", () => {
		const entries: LogEntry[] = [
			{ type: "message", turn: 0, message: { role: "user", content: "hi" } },
		];
		const classified = classifyEntries(entries);
		expect(classified.meta).toBeUndefined();
		expect(classified.end).toBeUndefined();
		expect(classified.messages.length).toBe(1);
		expect(classified.toolCalls.length).toBe(0);
	});

	it("should handle empty array", () => {
		const classified = classifyEntries([]);
		expect(classified.meta).toBeUndefined();
		expect(classified.messages.length).toBe(0);
		expect(classified.toolCalls.length).toBe(0);
	});
});
