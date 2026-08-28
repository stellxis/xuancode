import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryItem } from "@xuancode/types";
import {
	inferTags,
	jaccardSimilarity,
	keywordOverlapScore,
	scoreItems,
} from "./memoryRanker";

const JSON_FILE = "MEMORY.json";
const MD_FILE = "MEMORY.md";

export class MemoryStore {
	private items: MemoryItem[] = [];
	private jsonPath: string;
	private mdPath: string;

	constructor(memoryDir: string) {
		this.jsonPath = path.join(memoryDir, JSON_FILE);
		this.mdPath = path.join(memoryDir, MD_FILE);
	}

	// ========== I/O ==========

	/** Load from MEMORY.json (or migrate from MEMORY.md) */
	async load(): Promise<void> {
		try {
			const raw = await fs.readFile(this.jsonPath, "utf-8");
			this.items = JSON.parse(raw);
		} catch {
			const migrated = await this.tryMigrateFromMarkdown();
			if (!migrated) {
				this.items = [];
			}
		}
	}

	/** Save to MEMORY.json + sync MEMORY.md */
	async save(): Promise<void> {
		await fs.mkdir(path.dirname(this.jsonPath), { recursive: true });
		await fs.writeFile(
			this.jsonPath,
			JSON.stringify(this.items, null, 2),
			"utf-8",
		);
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

	/** Sync JSON → Markdown for human readability */
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
