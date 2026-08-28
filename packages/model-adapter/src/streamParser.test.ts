import { describe, expect, it } from "vitest";
import { parseSSEStream } from "./streamParser";
import type { StreamResult } from "./streamParser";

/** 模拟一个 SSE Response */
function mockSSEResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	return new Response(stream);
}

/** 收集所有 token 并返回完整结果 */
async function collectStream(
	gen: AsyncGenerator<any, StreamResult, unknown>,
): Promise<{ tokens: string[]; result: StreamResult }> {
	const tokens: string[] = [];
	let result: StreamResult = {
		fullContent: "",
		finishReason: null,
		usage: null,
	};
	let item = await gen.next();
	while (!item.done) {
		if (item.value?.content) tokens.push(item.value.content);
		item = await gen.next();
	}
	// item.done 后，item.value 包含 generator 的 return 值
	if (item.value) result = item.value;
	return { tokens, result };
}

describe("parseSSEStream", () => {
	it("should parse basic content chunks", async () => {
		const sse = [
			'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":" World"}}]}\n\n',
			"data: [DONE]\n\n",
		];
		const { tokens, result } = await collectStream(
			parseSSEStream(mockSSEResponse(sse)),
		);
		expect(tokens).toEqual(["Hello", " World"]);
		expect(result.fullContent).toBe("Hello World");
		expect(result.finishReason).toBeNull();
	});

	it("should extract finish_reason", async () => {
		const sse = [
			'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n',
			"data: [DONE]\n\n",
		];
		const { tokens, result } = await collectStream(
			parseSSEStream(mockSSEResponse(sse)),
		);
		expect(tokens).toEqual(["done"]);
		expect(result.finishReason).toBe("stop");
	});

	it("should extract usage from final chunk", async () => {
		const sse = [
			'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
			'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
			"data: [DONE]\n\n",
		];
		const { tokens, result } = await collectStream(
			parseSSEStream(mockSSEResponse(sse)),
		);
		expect(tokens).toEqual(["hello"]);
		expect(result.usage).toEqual({
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
		});
	});

	it("should handle [DONE] without preceding content", async () => {
		const sse = ["data: [DONE]\n\n"];
		const { tokens, result } = await collectStream(
			parseSSEStream(mockSSEResponse(sse)),
		);
		expect(tokens).toEqual([]);
		expect(result.fullContent).toBe("");
	});

	it("should skip heartbeat/comment lines", async () => {
		const sse = [
			": heartbeat\n\n",
			'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
			": keep-alive\n\n",
			"data: [DONE]\n\n",
		];
		const { tokens } = await collectStream(
			parseSSEStream(mockSSEResponse(sse)),
		);
		expect(tokens).toEqual(["hi"]);
	});

	it("should skip empty data lines", async () => {
		const sse = [
			"data:\n\n",
			"data: \n\n",
			'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
			"data: [DONE]\n\n",
		];
		const { tokens } = await collectStream(
			parseSSEStream(mockSSEResponse(sse)),
		);
		expect(tokens).toEqual(["ok"]);
	});

	it("should throw on malformed JSON in data", async () => {
		const sse = [
			'data: {"choices":[{"delta":{"content":"good"}}]}\n\n',
			"data: not-json\n\n",
		];
		const gen = parseSSEStream(mockSSEResponse(sse));
		// First chunk should work
		const first = await gen.next();
		expect(first.value?.content).toBe("good");
		// Second chunk should throw
		await expect(gen.next()).rejects.toThrow("SSE 数据解析失败");
	});

	it("should timeout if no data received", async () => {
		// 创建一个永不发送数据的流
		const stream = new ReadableStream({
			start() {
				/* never push anything */
			},
		});
		const response = new Response(stream as any);
		const gen = parseSSEStream(response, { timeout: 50 });
		await expect(gen.next()).rejects.toThrow("SSE 流超时");
	});

	it("should handle multi-line messages split across chunks", async () => {
		// 模拟 TCP 分片：一条 data 被拆成两个 TCP 包
		const firstPart = 'data: {"choices":[{"delta":{"content":"he';
		const secondPart = 'llo"}}]}\n\ndata: [DONE]\n\n';
		const sse = [firstPart, secondPart];
		const { tokens, result } = await collectStream(
			parseSSEStream(mockSSEResponse(sse)),
		);
		expect(tokens).toEqual(["hello"]);
		expect(result.fullContent).toBe("hello");
	});

	it("should handle concurrent data lines in one chunk", async () => {
		const sse = [
			'data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DONE]\n\n',
		];
		const { tokens, result } = await collectStream(
			parseSSEStream(mockSSEResponse(sse)),
		);
		expect(tokens).toEqual(["A", "B"]);
		expect(result.fullContent).toBe("AB");
	});

	it("C3-M1: 流式 tool_calls 在 finish_reason=tool_calls 时注入 JSON 行并保留原生 id", async () => {
		// 流式 tool_calls 增量（OpenAI 兼容），arguments 分片累加
		const sse = [
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"./a"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"pp.ts\\"}"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
			"data: [DONE]\n\n",
		];
		const { tokens, result } = await collectStream(
			parseSSEStream(mockSSEResponse(sse)),
		);
		expect(result.finishReason).toBe("tool_calls");
		// JSON 行包含原生 tool_call 的 id 与合并后的参数
		const line = tokens[tokens.length - 1];
		const parsed = JSON.parse(line);
		expect(parsed.type).toBe("read_file");
		expect(parsed.id).toBe("call_123");
		expect(parsed.path).toBe("./app.ts");
	});
});
