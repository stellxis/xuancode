import { describe, expect, it, vi } from "vitest";
import { RetryAdapter } from "./retry";

describe("RetryAdapter edge cases", () => {
	it("should not retry on 4xx errors", async () => {
		let attempts = 0;
		const adapter = {
			provider: "test",
			modelName: "test-model",
			chat: async () => {
				attempts++;
				throw new Error("400 Bad Request: invalid params");
			},
			chatStream: async function* () {
				yield "s";
			},
		};

		const retry = new RetryAdapter(adapter, { maxRetries: 3, baseDelay: 10 });
		await expect(retry.chat([])).rejects.toThrow("400 Bad Request");
		expect(attempts).toBe(1);
	});

	it("should retry on 429 rate limit", async () => {
		let attempts = 0;
		const adapter = {
			provider: "test",
			modelName: "test-model",
			chat: async () => {
				attempts++;
				if (attempts < 3) throw new Error("429 Too Many Requests");
				return "success";
			},
			chatStream: async function* () {
				yield "s";
			},
		};

		const retry = new RetryAdapter(adapter, { maxRetries: 3, baseDelay: 10 });
		const result = await retry.chat([]);
		expect(result).toBe("success");
		expect(attempts).toBe(3);
	});

	it("should retry on network error", async () => {
		let attempts = 0;
		const adapter = {
			provider: "test",
			modelName: "test-model",
			chat: async () => {
				attempts++;
				if (attempts < 2) throw new Error("fetch failed: ECONNREFUSED");
				return "network retry success";
			},
			chatStream: async function* () {
				yield "s";
			},
		};

		const retry = new RetryAdapter(adapter, { maxRetries: 2, baseDelay: 10 });
		const result = await retry.chat([]);
		expect(result).toBe("network retry success");
		expect(attempts).toBe(2);
	});

	it("should retry on 5xx errors", async () => {
		let attempts = 0;
		const adapter = {
			provider: "test",
			modelName: "test-model",
			chat: async () => {
				attempts++;
				if (attempts < 2) throw new Error("500 Internal Server Error");
				return "5xx retry success";
			},
			chatStream: async function* () {
				yield "s";
			},
		};

		const retry = new RetryAdapter(adapter, { maxRetries: 2, baseDelay: 10 });
		const result = await retry.chat([]);
		expect(result).toBe("5xx retry success");
	});

	it("should handle mixed error types (retryable then non-retryable)", async () => {
		let attempts = 0;
		const adapter = {
			provider: "test",
			modelName: "test-model",
			chat: async () => {
				attempts++;
				if (attempts === 1) throw new Error("503 Service Unavailable");
				throw new Error("400 Bad Request"); // non-retryable on second attempt
			},
			chatStream: async function* () {
				yield "s";
			},
		};

		const retry = new RetryAdapter(adapter, { maxRetries: 3, baseDelay: 10 });
		await expect(retry.chat([])).rejects.toThrow("400 Bad Request");
		expect(attempts).toBe(2);
	});

	it("should throw the last error after exhausting retries", async () => {
		const adapter = {
			provider: "test",
			modelName: "test-model",
			chat: async () => {
				throw new Error("503 Service Unavailable");
			},
			chatStream: async function* () {
				yield "s";
			},
		};

		const retry = new RetryAdapter(adapter, { maxRetries: 2, baseDelay: 10 });
		await expect(retry.chat([])).rejects.toThrow("503 Service Unavailable");
	});

	it("should retry stream on failure", async () => {
		let attempts = 0;
		const adapter = {
			provider: "test",
			modelName: "test-model",
			chat: async () => "ok",
			chatStream: async function* () {
				attempts++;
				if (attempts < 2) throw new Error("503 stream error");
				yield "stream success";
			},
		};

		const retry = new RetryAdapter(adapter, { maxRetries: 2, baseDelay: 10 });
		const tokens: string[] = [];
		for await (const token of retry.chatStream([])) {
			tokens.push(token);
		}
		expect(tokens.some((t) => t.includes("stream success"))).toBe(true);
		expect(attempts).toBe(2);
	});

	it("should not retry stream on 4xx", async () => {
		let attempts = 0;
		const adapter = {
			provider: "test",
			modelName: "test-model",
			chat: async () => "ok",
			// biome-ignore lint/correctness/useYield: 测试用例只需注入流错误，生成器内无 yield
			chatStream: async function* () {
				attempts++;
				throw new Error("401 Unauthorized");
			},
		};

		const retry = new RetryAdapter(adapter, { maxRetries: 2, baseDelay: 10 });
		await expect(async () => {
			for await (const _ of retry.chatStream([])) {
				/* */
			}
		}).rejects.toThrow("401 Unauthorized");
		expect(attempts).toBe(1);
	});

	it("should include retry info in stream output", async () => {
		let attempts = 0;
		const adapter = {
			provider: "test",
			modelName: "test-model",
			chat: async () => "ok",
			chatStream: async function* () {
				attempts++;
				if (attempts < 2) throw new Error("503 retry");
				yield "final content";
			},
		};

		const retry = new RetryAdapter(adapter, { maxRetries: 2, baseDelay: 10 });
		const tokens: string[] = [];
		for await (const token of retry.chatStream([])) {
			tokens.push(token);
		}
		// Should include retry notification tokens
		expect(tokens.length).toBeGreaterThanOrEqual(2);
		expect(tokens.some((t) => t.includes("重试"))).toBe(true);
		expect(tokens.some((t) => t.includes("final content"))).toBe(true);
	});

	it("should throw stream error after exhausting retries", async () => {
		const adapter = {
			provider: "test",
			modelName: "test-model",
			chat: async () => "ok",
			// biome-ignore lint/correctness/useYield: 测试用例只需注入流错误，生成器内无 yield
			chatStream: async function* () {
				throw new Error("503 persistent");
			},
		};

		const retry = new RetryAdapter(adapter, { maxRetries: 1, baseDelay: 10 });
		await expect(async () => {
			for await (const _ of retry.chatStream([])) {
				/* */
			}
		}).rejects.toThrow("503 persistent");
	});
});
