import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryItem, MemoryRankOptions, Message } from "@xuancode/types";
import { MemoryStore } from "./memoryStore";

/**
 * 六层记忆架构 (Six-layer Memory Architecture)
 *
 * 1. Managed Policy   — /etc/xuancode/xuancode.md (组织级策略)
 * 2. User Prefs       — ~/.xuancode/xuancode.md (用户偏好)
 * 3. Project Config   — ./xuancode.md / .xuancode/xuancode.md
 * 4. Auto-Memory      — ~/.xuancode/memory/MEMORY.md (结构化 JSON + 关键词检索)
 * 5. Session Context  — 当前会话
 * 6. Sub-Agent Memory — 子Agent专用记忆
 */

export interface MemoryLayer {
	name: string;
	path: string;
	priority: number;
	content: string;
	/** 衰减率 (0-1), 0 = 永不衰减, 默认 0.05 */
	decayRate?: number;
}

export class MemoryManager {
	private layers: MemoryLayer[] = [];
	private cacheDir: string;
	private store: MemoryStore;

	constructor(projectDir: string) {
		this.cacheDir = path.join(projectDir, ".xuancode");
		this.initLayers(projectDir);
		const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
		const memoryDir = path.join(homeDir, ".xuancode", "memory");
		this.store = new MemoryStore(memoryDir);
	}

	private initLayers(projectDir: string) {
		const homeDir = process.env.HOME || process.env.USERPROFILE || "~";

		this.layers = [
			{
				name: "managed_policy",
				path: path.join("/etc", "xuancode", "xuancode.md"),
				priority: 100,
				content: "",
				decayRate: 0, // 免衰减
			},
			{
				name: "user_prefs",
				path: path.join(homeDir, ".xuancode", "xuancode.md"),
				priority: 80,
				content: "",
				decayRate: 0,
			},
			{
				name: "project_config",
				path: path.join(projectDir, "xuancode.md"),
				priority: 60,
				content: "",
				decayRate: 0,
			},
			{
				name: "project_claude_dir",
				path: path.join(projectDir, ".xuancode", "xuancode.md"),
				priority: 50,
				content: "",
				decayRate: 0,
			},
			{
				name: "auto_memory",
				path: path.join(homeDir, ".xuancode", "memory", "MEMORY.md"),
				priority: 40,
				content: "",
				decayRate: 0.05, // 可衰减
			},
			{
				name: "session",
				path: path.join(this.cacheDir, "session-memory.md"),
				priority: 30,
				content: "",
				decayRate: 0.1,
			},
		];

		this.layers.push({
			name: "subagent",
			path: path.join(this.cacheDir, "subagent-memory.md"),
			priority: 20,
			content: "",
			decayRate: 0.1,
		});
	}

	/**
	 * Load all available memory layers.
	 * auto_memory 层通过 MemoryStore 加载（支持结构化检索）
	 */
	async loadAll(): Promise<MemoryLayer[]> {
		const loaded: MemoryLayer[] = [];

		for (const layer of this.layers) {
			if (layer.name === "auto_memory") {
				// Load auto_memory via MemoryStore (structured JSON)
				await this.store.load();
				const items = this.store.getAll();
				// Format as markdown for backward compatibility
				layer.content =
					items.length > 0
						? items
								.map((i) => `- [${i.tags[0] || "preference"}] ${i.text}`)
								.join("\n")
						: "";
				loaded.push({ ...layer });
			} else {
				try {
					const content = await fs.readFile(layer.path, "utf-8");
					layer.content = content;
					loaded.push({ ...layer });
				} catch {
					// File doesn't exist — skip silently
				}
			}
		}

		return loaded;
	}

	/**
	 * Build memory prompt string.
	 * @param userInput — 当前用户输入，用于检索 top-K 相关记忆。
	 *   不传则使用最近条目（fallback）。
	 */
	buildMemoryPrompt(userInput?: string): string {
		const otherLayers = this.layers
			.filter((l) => l.content.length > 0 && l.name !== "auto_memory")
			.sort((a, b) => b.priority - a.priority);

		const sections: string[] = [];

		// Other layers (unchanged)
		for (const layer of otherLayers) {
			sections.push(`[${layer.name}]\n${layer.content.trim()}`);
		}

		// Auto-memory: top-K scoring when userInput is given
		const allItems = this.store.getAll();
		if (allItems.length > 0) {
			const topItems = userInput
				? this.store.getTopK(userInput, { topK: 10, minScore: 0.05 })
				: allItems
						.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
						.slice(0, 10);

			const memLines = topItems.map((i) => {
				const tag = i.tags[0] || "preference";
				return `- [${tag}] ${i.text}`;
			});
			sections.push(`[auto_memory]\n${memLines.join("\n")}`);
		}

		return sections.join("\n\n");
	}

	/**
	 * Save a memory file (non-auto layers)
	 */
	async saveMemory(layerName: string, content: string): Promise<void> {
		if (layerName === "auto_memory") {
			throw new Error("auto_memory 层请使用 mergeLearnings/updateAutoMemory");
		}
		const layer = this.layers.find((l) => l.name === layerName);
		if (!layer) throw new Error(`未知记忆层: ${layerName}`);

		await fs.mkdir(path.dirname(layer.path), { recursive: true });
		await fs.writeFile(layer.path, content, "utf-8");
		layer.content = content;
	}

	/**
	 * Update auto-memory with session learnings (backward compatible).
	 * 内部委托给 MemoryStore.mergeItem() 实现去重 + 强化。
	 */
	async updateAutoMemory(learnings: string[]): Promise<void> {
		if (learnings.length === 0) return;
		await this.store.load();
		for (const text of learnings) {
			await this.store.mergeItem(text, inferLegacyTags(text));
		}
	}

	/**
	 * Merge learnings into auto-memory with dedup + reinforcement.
	 * @param learnings — 蒸馏出的学习内容列表
	 * @param source — 来源 sessionId（可选）
	 */
	async mergeLearnings(learnings: string[], source?: string): Promise<void> {
		if (learnings.length === 0) return;
		await this.store.load();
		await this.store.mergeLearnings(learnings, source);
	}

	/**
	 * Prune low-weight unpinned memories.
	 */
	async pruneMemory(minWeight?: number): Promise<number> {
		return this.store.prune(minWeight);
	}

	/**
	 * Get memory store stats.
	 */
	getMemoryStats(): {
		total: number;
		avgWeight: number;
		pinned: number;
		byTag: Record<string, number>;
	} {
		return this.store.getStats();
	}

	/** Get raw MemoryStore instance (for advanced operations) */
	getMemoryStore(): MemoryStore {
		return this.store;
	}

	/**
	 * Apply time decay to all auto_memory items.
	 * @returns number of items pruned after decay
	 */
	async decayAll(): Promise<number> {
		await this.store.load();
		this.store.decayAll();
		return this.store.prune(0.05);
	}

	/**
	 * Query auto_memory by category.
	 */
	query(category: string, topK = 10): MemoryItem[] {
		return this.store.queryByCategory(category, topK);
	}

	/**
	 * Get history timeline of auto_memory items by category.
	 */
	getHistory(category?: string): MemoryItem[] {
		return this.store.getHistory(category);
	}

	/**
	 * Call on first session of each day — triggers decay + prune.
	 */
	async onNewSession(): Promise<{ decayed: boolean; pruned: number }> {
		await this.store.load();
		const stats = this.store.getStats();
		if (stats.total === 0) return { decayed: false, pruned: 0 };
		this.store.decayAll();
		const pruned = await this.store.prune(0.05);
		return { decayed: true, pruned };
	}

	/**
	 * Inject memory context into messages (between system and user).
	 * 向后兼容 — 无用户输入时按原逻辑注入全部记忆。
	 */
	injectMemory(messages: Message[]): Message[] {
		const memoryPrompt = this.buildMemoryPrompt();
		if (!memoryPrompt) return messages;

		const systemIdx = messages.findIndex((m) => m.role === "system");
		if (systemIdx >= 0) {
			const result = [...messages];
			result.splice(systemIdx + 1, 0, {
				role: "system",
				content: `## 记忆上下文\n${memoryPrompt}`,
			});
			return result;
		}

		return messages;
	}

	getLayers(): MemoryLayer[] {
		return [...this.layers];
	}
}

/** Infer tag from legacy plain-text learning (no structured format) */
function inferLegacyTags(text: string): string[] {
	const lower = text.toLowerCase();
	const tags: string[] = [];
	if (
		lower.includes("prefer") ||
		lower.includes("习惯") ||
		lower.includes("喜欢")
	)
		tags.push("preference");
	if (
		lower.includes("decision") ||
		lower.includes("决定") ||
		lower.includes("选择")
	)
		tags.push("decision");
	if (
		lower.includes("constraint") ||
		lower.includes("必须") ||
		lower.includes("不能") ||
		lower.includes("禁止")
	)
		tags.push("constraint");
	if (
		lower.includes("pattern") ||
		lower.includes("模式") ||
		lower.includes("约定")
	)
		tags.push("pattern");
	if (tags.length === 0) tags.push("preference");
	return tags;
}
