import { describe, expect, it, vi } from "vitest";
import { MockAdapter } from "./index";
import { RetryAdapter } from "./retry";

describe("RetryAdapter", () => {
	it("should pass through successful calls", async () => {
		// MockAdapter first call returns a tool_call, second returns the mock response
		const inner = new MockAdapter();
		const retry = new RetryAdapter(inner, { maxRetries: 2 });

		const result1 = await retry.chat([{ role: "user", content: "hello" }]);
		expect(result1).toContain("list_dir"); // first call → tool call

		const result2 = await retry.chat([{ role: "user", content: "hello" }]);
		expect(result2).toContain("模拟响应"); // second call → mock response
	});

	it("should retry on failure and succeed eventually", async () => {
		let attempts = 0;
		const failingAdapter = {
			provider: "test",
			modelName: "test-model",
			chat: async () => {
				attempts++;
				if (attempts < 3) throw new Error("503 Service Unavailable");
				return "success on attempt 3";
			},
			chatStream: async function* () {
				yield "stream";
			},
		};

		const retry = new RetryAdapter(failingAdapter, {
			maxRetries: 3,
			baseDelay: 10,
		});

		const result = await retry.chat([]);
		expect(result).toBe("success on attempt 3");
		expect(attempts).toBe(3);
	});

	it("should throw after exhausting retries", async () => {
		let attempts = 0;
		const alwaysFails = {
			provider: "test",
			modelName: "test-model",
			chat: async () => {
				attempts++;
				throw new Error("503 Service Unavailable");
			},
			chatStream: async function* () {
				yield "stream";
			},
		};

		const retry = new RetryAdapter(alwaysFails, {
			maxRetries: 2,
			baseDelay: 10,
		});

		await expect(retry.chat([])).rejects.toThrow();
		expect(attempts).toBe(3); // 1 initial + 2 retries
	});

	it("should not retry 4xx errors", async () => {
		let attempts = 0;
		const badRequest = {
			provider: "test",
			modelName: "test-model",
			chat: async () => {
				attempts++;
				throw new Error("400 Bad Request");
			},
			chatStream: async function* () {
				yield "stream";
			},
		};

		const retry = new RetryAdapter(badRequest, {
			maxRetries: 3,
			baseDelay: 10,
		});

		await expect(retry.chat([])).rejects.toThrow();
		expect(attempts).toBe(1); // no retry for 4xx
	});
});
