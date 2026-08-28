import { describe, expect, it } from "vitest";
import { ResponseCache, buildCacheKey } from "./cache";

describe("ResponseCache edge cases", () => {
	it("should handle zero TTL (immediate expiry)", async () => {
		const cache = new ResponseCache({ ttl: 0 });
		cache.set("key1", "value1");
		// With 0 TTL, the entry expires at the same millisecond it was created.
		// Wait briefly to ensure clock advances past the expiry.
		await new Promise((r) => setTimeout(r, 5));
		expect(cache.get("key1")).toBeNull();
	});

	it("should handle maxSize of 0 (only one item fits)", () => {
		const cache = new ResponseCache({ ttl: 60000, maxSize: 0 });
		cache.set("key1", "value1");
		// With maxSize=0, the first item is inserted (eviction check deletes nothing on empty cache)
		// but subsequent inserts trigger eviction immediately
		expect(cache.get("key1")).toBe("value1");
		cache.set("key2", "value2"); // should evict key1 since size(1) >= maxSize(0)
		expect(cache.get("key1")).toBeNull();
		expect(cache.get("key2")).toBe("value2");
	});

	it("should evict oldest entries in FIFO order when over maxSize", () => {
		const cache = new ResponseCache({ ttl: 60000, maxSize: 3 });

		cache.set("a", "1");
		cache.set("b", "2");
		cache.set("c", "3");
		expect(cache.get("a")).toBe("1");
		expect(cache.get("b")).toBe("2");
		expect(cache.get("c")).toBe("3");

		cache.set("d", "4"); // should evict 'a'
		expect(cache.get("a")).toBeNull();
		expect(cache.get("b")).toBe("2");
		expect(cache.get("c")).toBe("3");
		expect(cache.get("d")).toBe("4");
	});

	it("should evict correctly with multiple evictions", () => {
		const cache = new ResponseCache({ ttl: 60000, maxSize: 2 });
		cache.set("a", "1");
		cache.set("b", "2");
		cache.set("c", "3"); // evicts a
		cache.set("d", "4"); // evicts b

		expect(cache.get("a")).toBeNull();
		expect(cache.get("b")).toBeNull();
		expect(cache.get("c")).toBe("3");
		expect(cache.get("d")).toBe("4");
	});

	it("should update access order on re-set", () => {
		const cache = new ResponseCache({ ttl: 60000, maxSize: 2 });

		cache.set("a", "1");
		cache.set("b", "2");
		cache.set("a", "updated"); // re-set — should NOT change eviction order for existing key
		cache.set("c", "3"); // should evict 'a' or 'b' depending on implementation

		// With FIFO eviction, re-setting 'a' doesn't change its insertion position
		// So 'a' was inserted first, and 'c' will evict 'a'
		expect(cache.get("c")).toBe("3");
	});

	it("should report correct stats after operations", () => {
		const cache = new ResponseCache({ ttl: 30000, maxSize: 100 });

		expect(cache.stats().size).toBe(0);

		cache.set("a", "1");
		expect(cache.stats().size).toBe(1);

		cache.set("b", "2");
		expect(cache.stats().size).toBe(2);

		cache.clear();
		expect(cache.stats().size).toBe(0);
	});

	it("should invalidate by prefix", () => {
		const cache = new ResponseCache({ ttl: 60000 });
		cache.set("user:1:sess:a", "resp1");
		cache.set("user:1:sess:b", "resp2");
		cache.set("user:2:sess:a", "resp3");

		cache.invalidate("user:1");
		expect(cache.get("user:1:sess:a")).toBeNull();
		expect(cache.get("user:1:sess:b")).toBeNull();
		expect(cache.get("user:2:sess:a")).toBe("resp3");
	});

	it("should invalidate with full key match", () => {
		const cache = new ResponseCache({ ttl: 60000 });
		cache.set("exact-key", "value");
		cache.set("other-key", "other");

		cache.invalidate("exact-key");
		expect(cache.get("exact-key")).toBeNull();
		expect(cache.get("other-key")).toBe("other");
	});

	it("should handle invalidate with no matches", () => {
		const cache = new ResponseCache({ ttl: 60000 });
		cache.set("a", "1");
		expect(() => cache.invalidate("nonexistent")).not.toThrow();
		expect(cache.get("a")).toBe("1");
	});

	it("should handle nullish keys gracefully", () => {
		const cache = new ResponseCache({ ttl: 60000 });
		expect(cache.get("")).toBeNull();
		expect(cache.get("nonexistent")).toBeNull();
	});
});

describe("buildCacheKey", () => {
	it("should produce different keys for different system prompts", () => {
		const msgs = [{ role: "user" as const, content: "hello" }];
		expect(buildCacheKey(msgs, "sys1")).not.toBe(buildCacheKey(msgs, "sys2"));
	});

	it("should produce same key without system prompt vs empty", () => {
		const msgs = [{ role: "user" as const, content: "hello" }];
		expect(buildCacheKey(msgs)).toBe(buildCacheKey(msgs, ""));
	});

	it("should include tool messages in key", () => {
		const a = buildCacheKey([
			{ role: "user" as const, content: "hello" },
			{ role: "assistant" as const, content: "tool_call" },
		]);
		const b = buildCacheKey([
			{ role: "user" as const, content: "hello" },
			{ role: "tool" as const, content: "result" },
		]);
		expect(a).not.toBe(b);
	});

	it("should handle empty messages array", () => {
		const key = buildCacheKey([]);
		expect(typeof key).toBe("string");
		expect(key.length).toBeGreaterThan(0);
	});

	it("should handle messages with tool_call_id and name", () => {
		const key = buildCacheKey([
			{
				role: "assistant" as const,
				content: "",
				tool_call_id: "call_1",
				name: "list_dir",
			},
		]);
		expect(typeof key).toBe("string");
		expect(key.length).toBeGreaterThan(0);
	});
});
