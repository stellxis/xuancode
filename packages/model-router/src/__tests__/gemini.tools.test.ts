import type { Message, NativeToolCall } from "@xuancode/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseAdapter } from "../adapters/base";
import { GeminiAdapter } from "../adapters/gemini";
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

/** 构造一条 Gemini SSE data 行 */
function sseData(parts: unknown[]): string {
	return `data: ${JSON.stringify({ candidates: [{ content: { parts } }] })}\n\n`;
}

/** mock fetch 返回给定的 Gemini SSE 块序列，并捕获请求 body */
function mockFetchStream(chunks: unknown[][]): { body: any } {
	const captured: { body: any } = { body: null };
	const payload = chunks.map((parts) => sseData(parts)).join("");
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

describe("BaseAdapter.buildGeminiMessage（C3-M4）", () => {
	it("role:'tool' → user 消息 + functionResponse part（name 由合成 id 还原）", () => {
		const out = BaseAdapter.buildGeminiMessage(
			msg({
				role: "tool",
				content: '{"ok":true}',
				tool_call_id: "list_dir::0",
			}),
		);
		expect(out.role).toBe("user");
		expect(out.parts).toEqual([
			{ functionResponse: { name: "list_dir", response: { ok: true } } },
		]);
	});

	it("role:'tool' 非 JSON content 原样作为 response", () => {
		const out = BaseAdapter.buildGeminiMessage(
			msg({ role: "tool", content: "plain text", tool_call_id: "list_dir::0" }),
		);
		expect(out.parts).toEqual([
			{ functionResponse: { name: "list_dir", response: "plain text" } },
		]);
	});

	it("assistant 带 toolCalls → model 角色 + 结构化 functionCall parts", () => {
		const out = BaseAdapter.buildGeminiMessage(
			msg({
				role: "assistant",
				content: "让我查看",
				toolCalls: [
					{ id: "list_dir::0", name: "list_dir", arguments: '{"path":"."}' },
				] as NativeToolCall[],
			}),
		);
		expect(out.role).toBe("model");
		expect(out.parts).toEqual([
			{ text: "让我查看" },
			{ functionCall: { name: "list_dir", args: { path: "." } } },
		]);
	});

	it("assistant 无 toolCalls 保持原样（文本，角色映射 model）", () => {
		const out = BaseAdapter.buildGeminiMessage(
			msg({ role: "assistant", content: "hi" }),
		);
		expect(out.role).toBe("model");
		expect(out.parts).toEqual([{ text: "hi" }]);
	});
});

describe("GeminiAdapter.chatStream（C3-M4 富结构）", () => {
	it("2.x 对象快照形态：跨 chunk 深合并 args → 文本增量 + 结构化 tool_calls 事件；tools 以 functionDeclarations 下发", async () => {
		const captured = mockFetchStream([
			[
				{ text: "让我查看目录" },
				{ functionCall: { name: "list_dir", args: { path: "" } } },
			],
			[
				{
					functionCall: {
						name: "list_dir",
						args: { path: ".", recursive: true },
					},
				},
			],
		]);

		const adapter = new GeminiAdapter("gemini-2.5-flash", { apiKey: "test" });
		const yielded: any[] = [];
		for await (const t of adapter.chatStream([msg()], "sys", tools))
			yielded.push(t);

		// 文本增量原样流出
		expect(yielded.filter((y) => typeof y === "string")).toEqual([
			"让我查看目录",
		]);
		// 富结构事件：合成 id "name::index"，args 为跨 chunk 深合并结果
		const event = yielded.find(
			(y) => typeof y === "object" && y.type === "tool_calls",
		);
		expect(event).toBeDefined();
		expect(event.toolCalls).toEqual([
			{
				id: "list_dir::0",
				name: "list_dir",
				arguments: '{"path":".","recursive":true}',
			},
		]);
		// tools 以 functionDeclarations 形状下发
		expect(captured.body.tools[0].functionDeclarations[0]).toEqual({
			name: "list_dir",
			description: "列出目录",
			parameters: tools[0].function.parameters,
		});
	});

	it("1.x 字符串形态：跨 chunk 拼接 partial JSON 字符串", async () => {
		const captured = mockFetchStream([
			[{ functionCall: { name: "list_dir", args: '{"path": ' } }],
			[{ functionCall: { name: "list_dir", args: '"."}' } }],
		]);
		const adapter = new GeminiAdapter("gemini-2.5-flash", { apiKey: "test" });
		const yielded: any[] = [];
		for await (const t of adapter.chatStream([msg()], "sys", tools))
			yielded.push(t);
		const event = yielded.find(
			(y) => typeof y === "object" && y.type === "tool_calls",
		);
		expect(event.toolCalls).toEqual([
			{ id: "list_dir::0", name: "list_dir", arguments: '{"path": "."}' },
		]);
	});

	it("同 chunk 内同名两次 → 视为两个独立调用（不误合并）", async () => {
		const captured = mockFetchStream([
			[
				{ functionCall: { name: "list_dir", args: { path: "." } } },
				{ functionCall: { name: "list_dir", args: { path: "src" } } },
			],
		]);
		const adapter = new GeminiAdapter("gemini-2.5-flash", { apiKey: "test" });
		const yielded: any[] = [];
		for await (const t of adapter.chatStream([msg()], "sys", tools))
			yielded.push(t);
		const event = yielded.find(
			(y) => typeof y === "object" && y.type === "tool_calls",
		);
		expect(event.toolCalls).toEqual([
			{ id: "list_dir::0", name: "list_dir", arguments: '{"path":"."}' },
			{ id: "list_dir::1", name: "list_dir", arguments: '{"path":"src"}' },
		]);
	});

	it("无 tools 时不带 tools 字段", async () => {
		const captured = mockFetchStream([[{ text: "ok" }]]);
		const adapter = new GeminiAdapter("gemini-2.5-flash", { apiKey: "test" });
		for await (const _ of adapter.chatStream([msg()], "sys")) void _;
		expect(captured.body.tools).toBeUndefined();
	});
});

describe("GeminiAdapter.chat（C3-M4 非流式）", () => {
	it("提取 functionCall 为 JSON 行文本（合成 id）", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						candidates: [
							{
								content: {
									parts: [
										{ text: "查看" },
										{ functionCall: { name: "list_dir", args: { path: "." } } },
									],
								},
							},
						],
					}),
					{ status: 200 },
				),
			),
		);
		const adapter = new GeminiAdapter("gemini-2.5-flash", { apiKey: "test" });
		const out = await adapter.chat([msg()], "sys", tools);
		expect(out).toContain('"type":"list_dir"');
		expect(out).toContain('"id":"list_dir::0"');
		expect(out).toContain('"path":"."');
	});

	it("无 functionCall 时回落到纯文本", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						candidates: [{ content: { parts: [{ text: "hello world" }] } }],
					}),
					{ status: 200 },
				),
			),
		);
		const adapter = new GeminiAdapter("gemini-2.5-flash", { apiKey: "test" });
		expect(await adapter.chat([msg()], "sys")).toBe("hello world");
	});
});
