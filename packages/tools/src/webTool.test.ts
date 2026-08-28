import { beforeAll, describe, expect, it } from "vitest";
import { webFetch, webSearch } from "./webTool";

describe("webSearch", () => {
	it("should reject empty query", async () => {
		const result = await webSearch("  ");
		expect(result.success).toBe(false);
		expect(result.error).toContain("不能为空");
	});

	it("should handle no API key gracefully", async () => {
		// Ensure no key is set
		const oldKey = process.env.SERPAPI_API_KEY;
		// 用 delete 而非置 undefined：Node 会把 undefined 存为字符串 "undefined"（真值），误触真实请求
		// biome-ignore lint/performance/noDelete: 删除 env 变量是唯一正确的清空方式
		delete process.env.SERPAPI_API_KEY;

		const result = await webSearch("typescript");
		expect(result.success).toBe(true);
		expect(result.data).toContain("未配置");

		// Restore
		if (oldKey) process.env.SERPAPI_API_KEY = oldKey;
	});

	it("should include duration", async () => {
		const result = await webSearch("hello");
		expect(result.duration).toBeGreaterThanOrEqual(0);
	});
});

describe("webFetch", () => {
	it("should reject empty URL", async () => {
		const result = await webFetch("  ");
		expect(result.success).toBe(false);
	});

	it("should reject non-http URLs", async () => {
		const result = await webFetch("file:///etc/passwd");
		expect(result.success).toBe(false);
		expect(result.error).toContain("仅支持 http/https");
	});

	it("should include duration on error", async () => {
		const result = await webFetch("https://nonexistent.example.com/test");
		expect(result.duration).toBeGreaterThanOrEqual(0);
	});
});
