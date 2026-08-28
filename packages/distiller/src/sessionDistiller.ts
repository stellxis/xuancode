import fs from "node:fs/promises";
import path from "node:path";
import { MemoryManager } from "@xuancode/context";
import type { ModelAdapter } from "@xuancode/model-adapter";
import type { Message } from "@xuancode/types";

const DISTILL_SYSTEM_PROMPT = `You are a session knowledge extractor. Analyze the following conversation between a user and an AI coding assistant. Extract reusable knowledge.

Extract information in these categories (max 5 per category):
1. **User preferences** — style choices, format requirements, naming conventions
2. **Project decisions** — architecture choices, tech stack decisions, design patterns
3. **Constraints** — important limitations to remember
4. **Code patterns** — recurring patterns or solutions

Format each line with: - [tag] description
Available tags: preference, decision, constraint, pattern

Example:
- [preference] Uses 2-space indentation
- [decision] Project uses pnpm workspace monorepo structure
- [constraint] Must not modify .env files
- [pattern] REST API follows /api/v1/{resource} pattern

If no valuable information, reply with "无".`;

const PATTERN_DETECT_PROMPT = `Analyze these extracted learnings from multiple coding sessions. Detect recurring patterns:

1. **Repeat patterns** — same command sequence, error type, or tool combination appearing across sessions
2. **Consolidated decisions** — related decisions that can be merged
3. **Trending topics** — topics appearing in 3+ sessions indicating growing importance

Output format:
- [pattern] description | occurrences: N

If no cross-session patterns found, reply with "无".`;

export interface DistillationResult {
	learnings: string[];
	summary: string;
}

export class SessionDistiller {
	private model: ModelAdapter;
	private workDir: string;

	constructor(model: ModelAdapter, workDir: string) {
		this.model = model;
		this.workDir = workDir;
	}

	/** 蒸馏：从对话消息中提取学习内容 */
	async distill(
		messages: Message[],
		_source?: string,
		lastDistillAt?: number,
	): Promise<DistillationResult> {
		if (messages.length < 4) {
			return { learnings: [], summary: "" };
		}

		// Filter messages since lastDistillAt
		let targetMessages = messages;
		if (lastDistillAt) {
			targetMessages = messages.filter(
				(m) => (m as any).timestamp > lastDistillAt || !(m as any).timestamp,
			);
		}

		const transcript = targetMessages
			.filter((m) => m.role === "user" || m.role === "assistant")
			.slice(-20)
			.map(
				(m) => `[${m.role.toUpperCase()}]\n${(m.content || "").slice(0, 2000)}`,
			)
			.join("\n\n");

		const prompt = `以下是本次 AI 编程会话的对话记录：\n\n${transcript}\n\n请提取可复用的知识：`;

		let raw: string;
		try {
			raw = await this.model.chat(
				[{ role: "user", content: prompt }],
				DISTILL_SYSTEM_PROMPT,
			);
		} catch (e) {
			console.error("[SessionDistiller] distill model call failed:", e);
			return { learnings: [], summary: "" };
		}

		if (!raw || raw.trim() === "无") {
			return { learnings: [], summary: "" };
		}

		const learnings: string[] = [];
		let summary = "";

		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("- ") && trimmed.length > 4) {
				learnings.push(trimmed.slice(2));
			} else if (trimmed.length > 0 && !trimmed.startsWith("```")) {
				summary += `${trimmed} `;
			}
		}

		return {
			learnings: learnings.slice(0, 20),
			summary: summary.trim(),
		};
	}

	/** 蒸馏并持久化到 MemoryManager auto_memory 层，自动触发跨会话分析 */
	async distillAndPersist(messages: Message[], source?: string): Promise<void> {
		if (messages.length < 4) return;

		const result = await this.distill(messages, source);
		if (result.learnings.length === 0) return;

		try {
			const memoryManager = new MemoryManager(this.workDir);
			await memoryManager.mergeLearnings(result.learnings, source);
		} catch (e) {
			console.error("[SessionDistiller] distillAndPersist failed:", e);
		}

		// Fire-and-forget cross-session pattern analysis
		this.autoCrossAnalyze(result.learnings, source).catch(() => {});
	}

	/**
	 * Analyze multiple session distillations and extract cross-session patterns.
	 * @param allLearnings — map of sessionId -> learnings from each session
	 * @returns detected patterns with occurrence counts
	 */
	async crossAnalyze(allLearnings: Map<string, string[]>): Promise<string[]> {
		const flatEntries: string[] = [];
		for (const [, learnings] of allLearnings) {
			flatEntries.push(...learnings);
		}
		if (flatEntries.length < 3) return [];

		const input = flatEntries.map((l, i) => `#${i + 1}: ${l}`).join("\n");
		let raw: string;
		try {
			raw = await this.model.chat(
				[
					{
						role: "user",
						content: `以下是从多个会话中提取的知识条目：\n\n${input}\n\n请检测跨会话模式：`,
					},
				],
				PATTERN_DETECT_PROMPT,
			);
		} catch (e) {
			console.error("[SessionDistiller] crossAnalyze failed:", e);
			return [];
		}

		if (!raw || raw.trim() === "无") return [];

		const patterns: string[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("- ") && trimmed.length > 4) {
				patterns.push(trimmed.slice(2));
			}
		}
		return patterns;
	}

	/**
	 * Persist cross-analysis patterns into MemoryManager auto_memory layer
	 * with the "pattern" tag.
	 */
	async persistPatterns(
		patterns: string[],
		sourceSessionIds?: string[],
	): Promise<void> {
		if (patterns.length === 0) return;
		try {
			const memoryManager = new MemoryManager(this.workDir);
			const store = memoryManager.getMemoryStore();
			await store.load();
			for (const pattern of patterns) {
				await store.mergeItem(
					pattern,
					["pattern"],
					sourceSessionIds?.join(","),
				);
			}
		} catch (e) {
			console.error("[SessionDistiller] persistPatterns failed:", e);
		}
	}

	/**
	 * Auto cross-session analysis pipeline:
	 * 1. Load accumulated session learnings from ~/.xuancode/memory/session-learnings.json
	 * 2. Append current session's learnings
	 * 3. If 3+ sessions accumulated, run crossAnalyze()
	 * 4. Persist detected patterns and prune old sessions
	 */
	async autoCrossAnalyze(
		currentLearnings: string[],
		sourceSessionId?: string,
	): Promise<void> {
		if (currentLearnings.length === 0) return;

		const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
		const learningsPath = path.join(
			homeDir,
			".xuancode",
			"memory",
			"session-learnings.json",
		);

		try {
			// Load accumulated learnings
			let sessions: Array<{
				sessionId: string;
				learnings: string[];
				timestamp: number;
			}> = [];
			try {
				const raw = await fs.readFile(learningsPath, "utf-8");
				sessions = JSON.parse(raw);
			} catch {
				/* start fresh */
			}

			// Append current session
			sessions.push({
				sessionId: sourceSessionId || `session-${Date.now()}`,
				learnings: currentLearnings,
				timestamp: Date.now(),
			});

			// Keep only recent 20 sessions
			if (sessions.length > 20) {
				sessions = sessions.slice(-20);
			}

			// Check if we have enough sessions for cross-session analysis
			if (sessions.length >= 3) {
				const allLearnings = new Map<string, string[]>();
				for (const s of sessions) {
					allLearnings.set(s.sessionId, s.learnings);
				}

				const patterns = await this.crossAnalyze(allLearnings);
				if (patterns.length > 0) {
					const sessionIds = sessions.map((s) => s.sessionId);
					await this.persistPatterns(patterns, sessionIds);

					// After successful analysis, prune old sessions (keep latest 5)
					sessions = sessions.slice(-5);
				}
			}

			// Save updated learnings
			await fs.mkdir(path.dirname(learningsPath), { recursive: true });
			await fs.writeFile(
				learningsPath,
				JSON.stringify(sessions, null, 2),
				"utf-8",
			);
		} catch (e) {
			console.error("[SessionDistiller] autoCrossAnalyze failed:", e);
		}
	}

	/**
	 * Detect patterns within a set of learnings.
	 * Returns learnings tagged as "pattern" category.
	 */
	detectPatterns(learnings: string[]): string[] {
		const patterns: string[] = [];
		const occurrenceMap = new Map<string, number>();

		// Simple keyword-based dedup: group similar learnings
		for (const l of learnings) {
			const tagMatch = l.match(/^\[(\w+)\]/);
			if (tagMatch && tagMatch[1] === "pattern") {
				// Check for similar existing patterns
				let found = false;
				for (const [key] of occurrenceMap) {
					const words = new Set(key.toLowerCase().split(/\s+/));
					const lWords = l.toLowerCase().split(/\s+/);
					const overlap = lWords.filter((w) => words.has(w)).length;
					if (overlap / Math.max(words.size, lWords.length) > 0.5) {
						occurrenceMap.set(key, occurrenceMap.get(key)! + 1);
						found = true;
						break;
					}
				}
				if (!found) {
					occurrenceMap.set(l, 1);
				}
			}
		}

		// Return patterns that appear 3+ times
		for (const [text, count] of occurrenceMap) {
			if (count >= 3) {
				patterns.push(`${text} | occurrences: ${count}`);
			}
		}
		return patterns;
	}
}
