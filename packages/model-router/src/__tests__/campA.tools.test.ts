import type { Message } from "@xuancode/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseAdapter } from "../adapters/base";
import { DeepSeekAdapter } from "../adapters/deepseek";
import { OllamaAdapter } from "../adapters/ollama";
import { OpenAIAdapter } from "../adapters/openai";
import type { ApiToolDefinition } from "../types";

const tools: ApiToolDefinition[] = [
	{
		type: "function",
		function: {
			name: "read_file",
			description: "读取文件",
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

describe("BaseAdapter.buildOpenAIMessage（C3-M2）", () => {
	it("原生 toolCalls → content 置空 + tool_calls 结构", () => {
		const out = BaseAdapter.buildOpenAIMessage(
			msg({
				role: "assistant",
				content: "先用工具",
				toolCalls: [
					{ id: "call_1", name: "read_file", arguments: '{"path":"./a.ts"}' },
				],
			}),
		);
		expect(out.content).toBe("");
		expect(out.tool_calls).toEqual([
			{
				id: "call_1",
				type: "function",
				function: { name: "read_file", arguments: '{"path":"./a.ts"}' },
			},
		]);
	});

	it("role:tool 消息带 tool_call_id", () => {
		const out = BaseAdapter.buildOpenAIMessage(
			msg({ role: "tool", content: "内容", tool_call_id: "call_1" }),
		);
		expect(out.tool_call_id).toBe("call_1");
		expect(out.content).toBe("内容");
	});

	it("普通消息无 tool_calls 保持原样", () => {
		const out = BaseAdapter.buildOpenAIMessage(msg());
		expect(out.content).toBe("hi");
		expect(out.tool_calls).toBeUndefined();
	});
});

describe("BaseAdapter.extractToolCallsText（C3-M2）", () => {
	it("无 tool_calls 返回 null", () => {
		expect(BaseAdapter.extractToolCallsText({ content: "ok" })).toBeNull();
		expect(BaseAdapter.extractToolCallsText(undefined)).toBeNull();
	});

	it("tool_calls → JSON 行带 id（{...args,...{type,id}} 与 streamParser 同构）", () => {
		const text = BaseAdapter.extractToolCallsText({
			content: "",
			tool_calls: [
				{
					id: "call_a",
					type: "function",
					function: { name: "list_dir", arguments: '{"path":"."}' },
				},
			],
		});
		expect(text).toBe(
			JSON.stringify({ path: ".", type: "list_dir", id: "call_a" }),
		);
	});

	it("参数非法 JSON 时降级为裸 type", () => {
		const text = BaseAdapter.extractToolCallsText({
			tool_calls: [
				{
					id: "x",
					type: "function",
					function: { name: "ls", arguments: "not-json" },
				},
			],
		});
		expect(text).toBe(JSON.stringify({ type: "ls", id: "x" }));
	});
});

describe("Camp A 适配器原生工具下发（C3-M2）", () => {
	it("OpenAIAdapter.chat 把 tools 写进 body 且用 buildOpenAIMessage 序列化", async () => {
		let captured: any;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_u: string, init: any) => {
				captured = JSON.parse(init.body);
				return {
					ok: true,
					json: async () => ({ choices: [{ message: { content: "你好" } }] }),
				};
			}),
		);
		const adapter = new OpenAIAdapter("gpt-4o-mini", { apiKey: "k" });
		const out = await adapter.chat(
			[
				msg({
					role: "assistant",
					content: "调工具",
					toolCalls: [
						{ id: "c1", name: "read_file", arguments: '{"path":"x"}' },
					],
				}),
				msg({ role: "tool", content: "ok", tool_call_id: "c1" }),
			],
			"sys",
			tools,
		);
		expect(out).toBe("你好");
		expect(captured.tools).toEqual(tools);
		expect(captured.messages[1].tool_calls[0].id).toBe("c1");
		expect(captured.messages[1].content).toBe("");
		expect(captured.messages[2].tool_call_id).toBe("c1");
	});

	it("DeepSeekAdapter.chat 非流式 tool_calls 提取为 JSON 行", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({
					choices: [
						{
							message: {
								content: "",
								tool_calls: [
									{
										id: "call_b",
										type: "function",
										function: { name: "write_file", arguments: '{"path":"a"}' },
									},
								],
							},
						},
					],
				}),
			})),
		);
		const adapter = new DeepSeekAdapter("deepseek-chat", { apiKey: "k" });
		const out = await adapter.chat([msg()], undefined, tools);
		expect(out).toBe(
			JSON.stringify({ path: "a", type: "write_file", id: "call_b" }),
		);
	});

	it("无 tools 时 body 不含 tools 字段", async () => {
		let captured: any;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_u: string, init: any) => {
				captured = JSON.parse(init.body);
				return {
					ok: true,
					json: async () => ({ choices: [{ message: { content: "hi" } }] }),
				};
			}),
		);
		const adapter = new OpenAIAdapter("gpt-4o-mini", { apiKey: "k" });
		await adapter.chat([msg()]);
		expect(captured.tools).toBeUndefined();
	});

	it("OllamaAdapter.chatStream 接受 tools 写进 body", async () => {
		let captured: any;
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						'data: {"choices":[{"delta":{"content":"流"}}]}\n\ndata: [DONE]\n\n',
					),
				);
				controller.close();
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_u: string, init: any) => {
				captured = JSON.parse(init.body);
				return { ok: true, body: stream };
			}),
		);
		const adapter = new OllamaAdapter("qwen2.5:7b");
		const chunks: string[] = [];
		for await (const c of adapter.chatStream([msg()], undefined, tools))
			chunks.push(c);
		expect(chunks.join("")).toBe("流");
		expect(captured.tools).toEqual(tools);
		expect(captured.stream).toBe(true);
	});
});
