import { describe, expect, it } from "vitest";
import { ResponseCache, buildCacheKey } from "./cache";

describe("buildCacheKey", () => {
	it("should produce consistent keys for same input", () => {
		const messages = [{ role: "user", content: "hello" }];
		expect(buildCacheKey(messages)).toBe(buildCacheKey(messages));
	});

	it("should produce different keys for different inputs", () => {
		const a = buildCacheKey([{ role: "user", content: "hello" }]);
		const b = buildCacheKey([{ role: "user", content: "world" }]);
		expect(a).not.toBe(b);
	});

	it("should include system prompt in key", () => {
		const withSys = buildCacheKey(
			[{ role: "user", content: "hi" }],
			"system prompt",
		);
		const withoutSys = buildCacheKey([{ role: "user", content: "hi" }]);
		expect(withSys).not.toBe(withoutSys);
	});
});

describe("ResponseCache", () => {
	it("should store and retrieve cache entries", () => {
		const cache = new ResponseCache({ ttl: 60000 });
		cache.set("key1", "response1");
		expect(cache.get("key1")).toBe("response1");
	});

	it("should return null for missing keys", () => {
		const cache = new ResponseCache();
		expect(cache.get("nonexistent")).toBeNull();
	});

	it("should expire entries after TTL", async () => {
		const cache = new ResponseCache({ ttl: 10 }); // 10ms TTL
		cache.set("key1", "response1");
		expect(cache.get("key1")).toBe("response1");

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(cache.get("key1")).toBeNull();
	});

	it("should evict oldest entries when over maxSize", () => {
		const cache = new ResponseCache({ ttl: 60000, maxSize: 3 });

		cache.set("a", "1");
		cache.set("b", "2");
		cache.set("c", "3");
		cache.set("d", "4"); // should evict 'a'

		expect(cache.get("a")).toBeNull();
		expect(cache.get("b")).toBe("2");
		expect(cache.get("c")).toBe("3");
		expect(cache.get("d")).toBe("4");
	});

	it("should invalidate matching keys", () => {
		const cache = new ResponseCache({ ttl: 60000 });
		cache.set("user:123:session:1", "resp1");
		cache.set("user:123:session:2", "resp2");
		cache.set("user:456:session:1", "resp3");

		cache.invalidate("user:123");
		expect(cache.get("user:123:session:1")).toBeNull();
		expect(cache.get("user:123:session:2")).toBeNull();
		expect(cache.get("user:456:session:1")).toBe("resp3");
	});

	it("should clear all entries", () => {
		const cache = new ResponseCache({ ttl: 60000 });
		cache.set("a", "1");
		cache.set("b", "2");
		cache.clear();
		expect(cache.get("a")).toBeNull();
		expect(cache.get("b")).toBeNull();
	});

	it("should report correct stats", () => {
		const cache = new ResponseCache({ ttl: 30000, maxSize: 100 });
		cache.set("a", "1");
		const stats = cache.stats();
		expect(stats.size).toBe(1);
		expect(stats.maxSize).toBe(100);
		expect(stats.ttl).toBe(30000);
		expect(stats.hits).toBe(0);
		expect(stats.misses).toBe(0);
		expect(stats.hitRate).toBe(0);
	});

	it("should track hit/miss ratio", () => {
		const cache = new ResponseCache({ ttl: 60000, maxSize: 100 });
		expect(cache.get("nonexistent")).toBeNull();
		expect(cache.stats().misses).toBe(1);
		expect(cache.stats().hits).toBe(0);
		expect(cache.stats().hitRate).toBe(0);

		cache.set("key1", "response1");
		expect(cache.get("key1")).toBe("response1");
		expect(cache.stats().hits).toBe(1);
		expect(cache.stats().misses).toBe(1);
		expect(cache.stats().hitRate).toBe(0.5);

		expect(cache.get("key1")).toBe("response1");
		expect(cache.stats().hits).toBe(2);
		expect(cache.stats().hitRate).toBeCloseTo(2 / 3);
	});
});
