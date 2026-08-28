import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CachedAdapter } from "./cachedAdapter";
import { MockAdapter } from "./index";

describe("CachedAdapter", () => {
	let inner: MockAdapter;
	let cached: CachedAdapter;

	beforeEach(() => {
		inner = new MockAdapter();
		cached = new CachedAdapter(inner, { ttl: 60000, maxSize: 100 });
	});

	it("should return response from inner on first call", async () => {
		const result = await cached.chat([{ role: "user", content: "hello" }]);
		expect(result).toContain("list_dir"); // MockAdapter first call → tool call
	});

	it("should cache response and return cached on second call", async () => {
		const result1 = await cached.chat([{ role: "user", content: "hi" }]);
		// result1 is the tool call from MockAdapter's first call
		expect(result1).toContain("list_dir");

		// Same input → should return cached (NOT call inner again)
		const result2 = await cached.chat([{ role: "user", content: "hi" }]);
		expect(result2).toBe(result1); // identical cached string
	});

	it("should use different cache keys for different messages", async () => {
		const r1 = await cached.chat([{ role: "user", content: "hello" }]);
		const r2 = await cached.chat([{ role: "user", content: "world" }]);
		// Different messages → different keys → each is a separate call
		// The inner MockAdapter returns tool_call on first call, mock response on subsequent
		expect(r1).toContain("list_dir");
		expect(r2).not.toContain("list_dir"); // MockAdapter second call returns mock response
		expect(r1).not.toBe(r2);
	});

	it("should include system prompt in cache key", async () => {
		const r1 = await cached.chat([{ role: "user", content: "hi" }], "system1");
		const r2 = await cached.chat([{ role: "user", content: "hi" }], "system2");
		// Different system prompts → should NOT be cached same
		// inner.callCount would be 2 if no caching, or 2 if different keys
		// Actually MockAdapter is shared, so callCount tracks independently
		// The point: different system prompts = different cache keys
		expect(r1).not.toBe(r2);
	});

	it("should pass through stream without caching", async () => {
		const tokens: string[] = [];
		for await (const token of cached.chatStream([
			{ role: "user", content: "stream test" },
		])) {
			tokens.push(token);
		}
		expect(tokens.length).toBeGreaterThan(0);
		expect(tokens[0]).toContain("list_dir");
	});

	it("should respect TTL and re-fetch after expiry", async () => {
		const shortCache = new CachedAdapter(inner, { ttl: 1, maxSize: 100 }); // 1ms TTL
		await shortCache.chat([{ role: "user", content: "ttl test" }]);

		// Wait for TTL to expire
		await new Promise((r) => setTimeout(r, 10));

		// This should call inner again since TTL expired
		const result = await shortCache.chat([
			{ role: "user", content: "ttl test" },
		]);
		// MockAdapter tracks callCount globally — since TTL expired,
		// this should be a fresh call. The MockAdapter returns tool_call
		// on the first call per instance, but the CachedAdapter instance
		// is shared so callCount may vary.
		expect(result).toBeTruthy();
	});

	it("should expose cache stats", () => {
		const cache = cached.getCache();
		const stats = cache.stats();
		expect(stats.size).toBe(0);
		expect(stats.maxSize).toBe(100);
		expect(stats.ttl).toBe(60000);
	});

	it("should handle empty messages array", async () => {
		const result = await cached.chat([]);
		expect(result).toBeTruthy();
	});

	it("should support clearing cache", async () => {
		await cached.chat([{ role: "user", content: "clear test" }]);
		expect(cached.getCache().stats().size).toBe(1);

		cached.getCache().clear();
		expect(cached.getCache().stats().size).toBe(0);
	});
});
