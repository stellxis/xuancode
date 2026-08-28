/**
 * 玄码 Model Adapter 缓存层
 *
 * 为 LLM API 调用提供响应缓存，减少重复 API 请求。
 * 支持内存和文件两种存储后端，LRU 淘汰策略。
 * 内置命中/未命中统计。
 */

import fs from "node:fs/promises";
import path from "node:path";

// ===== 缓存配置 =====

export interface CacheConfig {
	/** 缓存 TTL（毫秒），默认 5 分钟 */
	ttl: number;
	/** 最大缓存条目数，默认 500 */
	maxSize: number;
	/** 存储后端 */
	storage: "memory" | "file";
	/** 文件存储路径（仅 file 模式） */
	fileDir?: string;
}

const DEFAULT_CONFIG: CacheConfig = {
	ttl: 5 * 60 * 1000,
	maxSize: 500,
	storage: "memory",
};

// ===== 缓存条目 =====

interface CacheEntry {
	response: string;
	cachedAt: number;
	expiresAt: number;
	/** 用于审计的元信息 */
	modelProvider: string;
	modelName: string;
	tokenEstimate?: number;
}

/** 序列化格式（用于文件持久化） */
interface CacheSnapshot {
	version: 1;
	entries: Array<{ key: string; entry: CacheEntry }>;
	stats: { hits: number; misses: number };
}

// ===== 缓存键 =====

export function buildCacheKey(
	messages: { role: string; content: string }[],
	systemPrompt?: string,
): string {
	const input = systemPrompt
		? `system:${systemPrompt}|${messages.map((m) => `${m.role}:${m.content.slice(0, 200)}`).join("|")}`
		: messages.map((m) => `${m.role}:${m.content.slice(0, 200)}`).join("|");
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		const char = input.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash |= 0;
	}
	return `${hash}`;
}

// ===== 响应缓存 =====

export class ResponseCache {
	private cache = new Map<string, CacheEntry>();
	private config: CacheConfig;
	private hits = 0;
	private misses = 0;

	constructor(config?: Partial<CacheConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/** 获取缓存响应（如果未过期） */
	get(key: string): string | null {
		const entry = this.cache.get(key);
		if (!entry) {
			this.misses++;
			return null;
		}

		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			this.misses++;
			return null;
		}

		this.hits++;
		return entry.response;
	}

	/** 存入缓存 */
	set(
		key: string,
		response: string,
		meta?: { provider?: string; model?: string },
	): void {
		if (this.cache.size >= this.config.maxSize) {
			const oldest = this.cache.keys().next().value;
			if (oldest) this.cache.delete(oldest);
		}

		this.cache.set(key, {
			response,
			cachedAt: Date.now(),
			expiresAt: Date.now() + this.config.ttl,
			modelProvider: meta?.provider || "unknown",
			modelName: meta?.model || "unknown",
		});
	}

	/** 删除匹配前缀的缓存 */
	invalidate(pattern: string): void {
		for (const [key] of this.cache) {
			if (key.startsWith(pattern)) {
				this.cache.delete(key);
			}
		}
	}

	/** 清空所有缓存 */
	clear(): void {
		this.cache.clear();
	}

	/** 缓存命中率 */
	hitRate(): number {
		const total = this.hits + this.misses;
		return total === 0 ? 0 : this.hits / total;
	}

	// ===== 文件持久化 =====

	/**
	 * 将缓存快照写入磁盘（仅 file 模式可用）。
	 * 保留未过期的条目和统计。
	 */
	async save(): Promise<void> {
		if (this.config.storage !== "file" || !this.config.fileDir) return;

		const now = Date.now();
		const entries: CacheSnapshot["entries"] = [];
		for (const [key, entry] of this.cache) {
			if (entry.expiresAt > now) {
				entries.push({ key, entry });
			}
		}

		const snapshot: CacheSnapshot = {
			version: 1,
			entries,
			stats: { hits: this.hits, misses: this.misses },
		};

		await fs.mkdir(this.config.fileDir, { recursive: true });
		await fs.writeFile(
			path.join(this.config.fileDir, "cache.json"),
			JSON.stringify(snapshot),
			"utf-8",
		);
	}

	/** 从磁盘加载缓存快照 */
	async load(): Promise<void> {
		if (this.config.storage !== "file" || !this.config.fileDir) return;

		const filePath = path.join(this.config.fileDir, "cache.json");
		try {
			const raw = await fs.readFile(filePath, "utf-8");
			const snapshot: CacheSnapshot = JSON.parse(raw);

			if (snapshot.version !== 1) return;

			const now = Date.now();
			for (const { key, entry } of snapshot.entries) {
				if (entry.expiresAt > now) {
					this.cache.set(key, entry);
				}
			}

			this.hits = snapshot.stats.hits;
			this.misses = snapshot.stats.misses;
		} catch {
			// 首次启动时文件不存在，静默忽略
		}
	}

	/** 缓存统计 */
	stats(): {
		size: number;
		maxSize: number;
		ttl: number;
		hits: number;
		misses: number;
		hitRate: number;
	} {
		return {
			size: this.cache.size,
			maxSize: this.config.maxSize,
			ttl: this.config.ttl,
			hits: this.hits,
			misses: this.misses,
			hitRate: this.hitRate(),
		};
	}
}
