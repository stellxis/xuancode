import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryItem } from "@xuancode/types";
import {
	inferTags,
	jaccardSimilarity,
	keywordOverlapScore,
	scoreItems,
} from "./memoryRanker";

/**
 * L5 auto_memory 存储。
 *
 * 事实源：每条记忆一个 md 文件（items/<id>.md，frontmatter 元数据 + 正文），
 * 便于文件级 GC / 分域 / 同步。
 * 兼容链：items/ 目录 → 旧 MEMORY.json 迁移（改名 .bak）→ 旧 MEMORY.md 迁移。
 * 过渡期 save() 继续同步生成 MEMORY.md，供旧版本降级读取。
 */
const MD_FILE = "MEMORY.md";
const ITEMS_DIR = "items";

export class MemoryStore {
	private items: MemoryItem[] = [];
	private itemsDir: string;
	private legacyJsonPath: string;
	private mdPath: string;

	constructor(memoryDir: string) {
		this.itemsDir = path.join(memoryDir, ITEMS_DIR);
		this.legacyJsonPath = path.join(memoryDir, "MEMORY.json");
		this.mdPath = path.join(memoryDir, MD_FILE);
	}

	// ========== I/O ==========

	/** Load: items/ 目录 → MEMORY.json 迁移 → MEMORY.md 迁移 */
	async load(): Promise<void> {
		const loaded = await this.tryLoadFromItemsDir();
		if (loaded) return;
		const migratedJson = await this.tryMigrateFromJson();
		if (migratedJson) return;
		const migratedMd = await this.tryMigrateFromMarkdown();
		if (!migratedMd) {
			this.items = [];
		}
	}

	/** Save: 全量落 items/*.md + 清理已删除文件 + 同步 MEMORY.md（过渡期兼容） */
	async save(): Promise<void> {
		await fs.mkdir(this.itemsDir, { recursive: true });
		const keep = new Set<string>();
		for (const item of this.items) {
			keep.add(`${item.id}.md`);
			await fs.writeFile(
				path.join(this.itemsDir, `${item.id}.md`),
				this.serializeItem(item),
				"utf-8",
			);
		}
		// 删除已不在内存中的条目文件（deleteItem 后的落盘）
		try {
			for (const f of await fs.readdir(this.itemsDir)) {
				if (f.endsWith(".md") && !keep.has(f)) {
					await fs.rm(path.join(this.itemsDir, f));
				}
			}
		} catch {
			// 目录不可读时忽略，不影响主流程
		}
		await this.syncMarkdown();
	}

	// ========== CRUD ==========

	/** Get all items */
	getAll(): MemoryItem[] {
		return [...this.items];
	}

	/** Get item by ID */
	getById(id: string): MemoryItem | undefined {
		return this.items.find((i) => i.id === id);
	}

	/** Merge a single learning: Jaccard dedup → reinforce or insert */
	async mergeItem(
		text: string,
		tags: string[],
		source?: string,
	): Promise<void> {
		let bestIdx = -1;
		let bestScore = 0;

		for (let i = 0; i < this.items.length; i++) {
			const score = jaccardSimilarity(text, this.items[i].text);
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		}

		if (bestScore >= 0.6 && bestIdx >= 0) {
			this.reinforce(bestIdx, tags);
		} else {
			this.insert(text, tags, source);
		}

		await this.save();
	}

	/** Batch merge learnings */
	async mergeLearnings(learnings: string[], source?: string): Promise<void> {
		for (const text of learnings) {
			const tags = inferTags(text);
			await this.mergeItem(text, tags, source);
		}
	}

	/** Get top-K items scored against a query */
	getTopK(
		query: string,
		options?: { topK?: number; minScore?: number; decayLambda?: number },
	): MemoryItem[] {
		const result = scoreItems(this.items, query, options);
		// Update access stats
		const now = Date.now();
		for (const { item } of result) {
			item.lastAccessedAt = now;
			item.accessCount += 1;
		}
		// 访问统计落盘：否则重启后检索记录丢失，活跃度被系统性低估
		// （每次任务触发一次，频率低；fire-and-forget 不阻塞调用方）
		this.save().catch(() => {});
		return result.map((s) => s.item);
	}

	/** Remove low-weight unpinned items */
	async prune(minWeight = 0.05): Promise<number> {
		const before = this.items.length;
		// Apply time decay to weights before pruning
		for (const item of this.items) {
			if (!item.pinned) {
				const daysSinceAccess = (Date.now() - item.lastAccessedAt) / 86_400_000;
				item.weight *= Math.exp(-0.005 * daysSinceAccess);
				item.weight = Math.round(item.weight * 100) / 100;
			}
		}
		this.items = this.items.filter((i) => i.pinned || i.weight >= minWeight);
		const pruned = before - this.items.length;
		if (pruned > 0) await this.save();
		return pruned;
	}

	/** Get stats */
	getStats(): {
		total: number;
		avgWeight: number;
		pinned: number;
		byTag: Record<string, number>;
	} {
		const byTag: Record<string, number> = {};
		for (const item of this.items) {
			for (const tag of item.tags) {
				byTag[tag] = (byTag[tag] || 0) + 1;
			}
		}
		return {
			total: this.items.length,
			avgWeight:
				this.items.length > 0
					? this.items.reduce((s, i) => s + i.weight, 0) / this.items.length
					: 0,
			pinned: this.items.filter((i) => i.pinned).length,
			byTag,
		};
	}

	/** Pin/unpin */
	async setPinned(id: string, pinned: boolean): Promise<void> {
		const item = this.items.find((i) => i.id === id);
		if (item) {
			item.pinned = pinned;
			await this.save();
		}
	}

	/** Reinforce by ID */
	async reinforceById(id: string): Promise<void> {
		const item = this.items.find((i) => i.id === id);
		if (item) {
			item.weight = Math.min(1.0, item.weight + 0.1);
			item.accessCount += 1;
			item.lastAccessedAt = Date.now();
			await this.save();
		}
	}

	/**
	 * Apply time decay to all unpinned items.
	 * Formula: weight *= (1 - decayRate)^days
	 */
	decayAll(decayRate = 0.05): void {
		const now = Date.now();
		for (const item of this.items) {
			if (item.pinned) continue;
			const daysSinceAccess = (now - item.lastAccessedAt) / 86_400_000;
			if (daysSinceAccess < 1) continue; // only decay items untouched for 1+ day
			item.weight *= (1 - decayRate) ** daysSinceAccess;
			item.weight = Math.round(item.weight * 100) / 100;
		}
	}

	/**
	 * Query items by category tag, sorted by score descending.
	 */
	queryByCategory(category: string, topK = 10): MemoryItem[] {
		return this.items
			.filter((i) => i.tags.includes(category))
			.sort((a, b) => {
				const aScore =
					a.weight *
					Math.exp((-0.005 * (Date.now() - a.lastAccessedAt)) / 86_400_000);
				const bScore =
					b.weight *
					Math.exp((-0.005 * (Date.now() - b.lastAccessedAt)) / 86_400_000);
				return bScore - aScore;
			})
			.slice(0, topK);
	}

	/**
	 * Get history timeline, optionally filtered by category.
	 */
	getHistory(category?: string): MemoryItem[] {
		const filtered = category
			? this.items.filter((i) => i.tags.includes(category))
			: [...this.items];
		return filtered.sort((a, b) => b.createdAt - a.createdAt);
	}

	/** Delete by ID */
	async deleteItem(id: string): Promise<void> {
		this.items = this.items.filter((i) => i.id !== id);
		await this.save();
	}

	// ========== Private ==========

	private reinforce(idx: number, tags: string[]): void {
		const item = this.items[idx];
		item.weight = Math.min(1.0, item.weight + 0.1);
		item.accessCount += 1;
		item.lastAccessedAt = Date.now();
		for (const tag of tags) {
			if (!item.tags.includes(tag)) item.tags.push(tag);
		}
	}

	private insert(text: string, tags: string[], source?: string): void {
		this.items.push({
			id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			text,
			tags,
			source,
			weight: 0.6,
			pinned: false,
			createdAt: Date.now(),
			lastAccessedAt: Date.now(),
			accessCount: 1,
		});
	}

	// ----- items/*.md 序列化 -----

	private serializeItem(item: MemoryItem): string {
		const meta: Record<string, string> = {
			id: item.id,
			tags: JSON.stringify(item.tags),
			source: JSON.stringify(item.source ?? null),
			weight: String(item.weight),
			pinned: String(item.pinned),
			createdAt: String(item.createdAt),
			lastAccessedAt: String(item.lastAccessedAt),
			accessCount: String(item.accessCount),
		};
		const lines = ["---"];
		for (const [k, v] of Object.entries(meta)) lines.push(`${k}: ${v}`);
		lines.push("---", "", item.text, "");
		return lines.join("\n");
	}

	private deserializeItem(raw: string): MemoryItem | null {
		const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
		if (!m) return null;
		const meta: Record<string, string> = {};
		for (const line of m[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
		}
		const text = m[2].trim();
		if (!meta.id || !text) return null;
		const num = (key: string, fallback: number): number => {
			const n = Number(meta[key]);
			return Number.isFinite(n) ? n : fallback;
		};
		let tags: string[] = [];
		try {
			const parsed = JSON.parse(meta.tags || "[]");
			if (Array.isArray(parsed)) tags = parsed.map(String);
		} catch {
			tags = [];
		}
		let source: string | undefined;
		try {
			const parsed = JSON.parse(meta.source || "null");
			if (typeof parsed === "string") source = parsed;
		} catch {
			source = undefined;
		}
		return {
			id: meta.id,
			text,
			tags,
			source,
			weight: num("weight", 0.6),
			pinned: meta.pinned === "true",
			createdAt: num("createdAt", Date.now()),
			lastAccessedAt: num("lastAccessedAt", Date.now()),
			accessCount: num("accessCount", 1),
		};
	}

	private async tryLoadFromItemsDir(): Promise<boolean> {
		try {
			const files = (await fs.readdir(this.itemsDir)).filter((f) =>
				f.endsWith(".md"),
			);
			if (files.length === 0) return false;
			const items: MemoryItem[] = [];
			for (const f of files) {
				try {
					const raw = await fs.readFile(path.join(this.itemsDir, f), "utf-8");
					const item = this.deserializeItem(raw);
					if (item) items.push(item);
				} catch {
					// 单文件损坏跳过，不阻塞其余记忆
				}
			}
			if (items.length === 0) return false;
			this.items = items;
			return true;
		} catch {
			return false;
		}
	}

	/** 旧 MEMORY.json → items/*.md，旧文件改名 .bak */
	private async tryMigrateFromJson(): Promise<boolean> {
		try {
			const raw = await fs.readFile(this.legacyJsonPath, "utf-8");
			const legacy = JSON.parse(raw) as MemoryItem[];
			if (!Array.isArray(legacy) || legacy.length === 0) return false;
			this.items = legacy;
			await this.save();
			await fs.rename(this.legacyJsonPath, `${this.legacyJsonPath}.bak`);
			return true;
		} catch {
			return false;
		}
	}

	/** Try migrating from old flat MEMORY.md format */
	private async tryMigrateFromMarkdown(): Promise<boolean> {
		try {
			const raw = await fs.readFile(this.mdPath, "utf-8");
			let migrated = 0;
			for (const line of raw.split("\n")) {
				const trimmed = line.trim();
				const tagMatch = trimmed.match(/^-\s+\[(\w+)\]\s+(.+)/);
				if (tagMatch) {
					const text = tagMatch[2].trim();
					if (text) {
						this.insert(text, [tagMatch[1]]);
						migrated++;
					}
				} else if (trimmed.startsWith("- ") && trimmed.length > 4) {
					const text = trimmed.slice(2).trim();
					if (text && !text.startsWith("```")) {
						this.insert(text, inferTags(text));
						migrated++;
					}
				}
			}
			if (migrated > 0) {
				await this.save();
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	/** Sync → Markdown for human readability（过渡期：旧版本降级读取靠它） */
	private async syncMarkdown(): Promise<void> {
		const lines: string[] = ["# 玄码自动记忆\n"];
		for (const item of this.items) {
			const tagStr = item.tags.length > 0 ? `[${item.tags[0]}]` : "";
			const pinMark = item.pinned ? " ⭐" : "";
			const w = (item.weight * 100).toFixed(0);
			lines.push(`- ${tagStr} ${item.text} (${w}%)${pinMark}`);
		}
		await fs.writeFile(this.mdPath, lines.join("\n"), "utf-8");
	}
}
