import type { Message, NativeToolCall } from "@xuancode/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicAdapter } from "../adapters/anthropic";
import { BaseAdapter } from "../adapters/base";
import type { ApiToolDefinition } from "../types";

const tools: ApiToolDefinition[] = [
	{
		type: "function",
		function: {
			name: "list_dir",
			description: "列出目录",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
	},
];

function msg(over: Partial<Message> = {}): Message {
	return { role: "user", content: "hi", ...over } as Message;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

/** 构造一条 Anthropic SSE 事件文本（event + data 行） */
function sseLine(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** mock fetch 返回给定的 SSE 事件序列，并捕获请求 body */
function mockFetchStream(events: Array<[string, unknown]>): { body: any } {
	const captured: { body: any } = { body: null };
	const payload = events.map(([e, d]) => sseLine(e, d)).join("");
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(payload));
			controller.close();
		},
	});
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
			captured.body = JSON.parse(String(init?.body));
			return new Response(stream, { status: 200 });
		}),
	);
	return captured;
}

describe("BaseAdapter.buildAnthropicMessage（C3-M3）", () => {
	it("role:'tool' → user 消息 + tool_result block（tool_use_id 对齐）", () => {
		const out = BaseAdapter.buildAnthropicMessage(
			msg({ role: "tool", content: '{"ok":true}', tool_call_id: "toolu_1" }),
		);
		expect(out.role).toBe("user");
		expect(out.content).toEqual([
			{ type: "tool_result", tool_use_id: "toolu_1", content: '{"ok":true}' },
		]);
	});

	it("assistant 带 toolCalls → text block + 结构化 tool_use blocks", () => {
		const out = BaseAdapter.buildAnthropicMessage(
			msg({
				role: "assistant",
				content: "让我查看",
				toolCalls: [
					{ id: "toolu_1", name: "list_dir", arguments: '{"path":"."}' },
				] as NativeToolCall[],
			}),
		);
		expect(out.role).toBe("assistant");
		expect(out.content).toEqual([
			{ type: "text", text: "让我查看" },
			{
				type: "tool_use",
				id: "toolu_1",
				name: "list_dir",
				input: { path: "." },
			},
		]);
	});

	it("assistant 无 toolCalls 保持原样（文本）", () => {
		const out = BaseAdapter.buildAnthropicMessage(
			msg({ role: "assistant", content: "hi" }),
		);
		expect(out.content).toBe("hi");
	});
});

describe("AnthropicAdapter.chatStream（C3-M3 富结构）", () => {
	it("流式累加 tool_use → 文本增量 + 结构化 tool_calls 事件；tools 以 input_schema 下发", async () => {
		const captured = mockFetchStream([
			[
				"content_block_delta",
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "让我查看目录" },
				},
			],
			[
				"content_block_start",
				{
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "tool_use",
						id: "toolu_abc",
						name: "list_dir",
						input: {},
					},
				},
			],
			[
				"content_block_delta",
				{
					type: "content_block_delta",
					index: 1,
					delta: { type: "input_json_delta", partial_json: '{"path": ' },
				},
			],
			[
				"content_block_delta",
				{
					type: "content_block_delta",
					index: 1,
					delta: { type: "input_json_delta", partial_json: '"."}' },
				},
			],
			["content_block_stop", { type: "content_block_stop", index: 1 }],
			[
				"message_delta",
				{ type: "message_delta", delta: { stop_reason: "tool_use" } },
			],
		]);

		const adapter = new AnthropicAdapter("claude-sonnet-4-6", {
			apiKey: "test",
		});
		const yielded: any[] = [];
		for await (const t of adapter.chatStream([msg()], "sys", tools))
			yielded.push(t);

		// 文本增量原样流出
		expect(yielded.filter((y) => typeof y === "string")).toEqual([
			"让我查看目录",
		]);
		// 富结构事件带完整 tool_use（id/name/拼接的 arguments）
		const event = yielded.find(
			(y) => typeof y === "object" && y.type === "tool_calls",
		);
		expect(event).toBeDefined();
		expect(event.toolCalls).toEqual([
			{ id: "toolu_abc", name: "list_dir", arguments: '{"path": "."}' },
		]);
		// tools 以 input_schema 形状下发
		expect(captured.body.tools[0]).toEqual({
			name: "list_dir",
			description: "列出目录",
			input_schema: tools[0].function.parameters,
		});
	});

	it("无 tools 时不带 tools 字段", async () => {
		const captured = mockFetchStream([
			[
				"content_block_delta",
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "ok" },
				},
			],
		]);
		const adapter = new AnthropicAdapter("claude-sonnet-4-6", {
			apiKey: "test",
		});
		for await (const _ of adapter.chatStream([msg()], "sys")) void _;
		expect(captured.body.tools).toBeUndefined();
	});
});

describe("AnthropicAdapter.chat（C3-M3 非流式）", () => {
	it("提取 tool_use 为 JSON 行文本（带原生 id）", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						content: [
							{ type: "text", text: "查看" },
							{
								type: "tool_use",
								id: "toolu_1",
								name: "list_dir",
								input: { path: "." },
							},
						],
					}),
					{ status: 200 },
				),
			),
		);
		const adapter = new AnthropicAdapter("claude-sonnet-4-6", {
			apiKey: "test",
		});
		const out = await adapter.chat([msg()], "sys", tools);
		expect(out).toContain('"type":"list_dir"');
		expect(out).toContain('"id":"toolu_1"');
		expect(out).toContain('"path":"."');
	});

	it("无 tool_use 时回落到纯文本", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						content: [{ type: "text", text: "hello world" }],
					}),
					{ status: 200 },
				),
			),
		);
		const adapter = new AnthropicAdapter("claude-sonnet-4-6", {
			apiKey: "test",
		});
		expect(await adapter.chat([msg()], "sys")).toBe("hello world");
	});
});
