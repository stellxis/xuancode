/**
 * 会话持久化与对话摘要 — 从 index.ts 抽出的纯逻辑，便于单测
 */

import fs from "node:fs";
import path from "node:path";
import type { Message } from "@xuancode/types";

// ===== 会话持久化 =====

export interface SessionRecord {
	timestamp: number;
	userInput: string;
	finalAnswer: string;
	turnCount: number;
	toolCallCount: number;
}

export interface SessionStore {
	saveSession: (record: SessionRecord) => void;
	clearSessions: () => void;
	loadLastSession: () => string | null;
}

export function createSessionStore(sessionFile: string): SessionStore {
	function ensureSessionDir(): void {
		const dir = path.dirname(sessionFile);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	function saveSession(record: SessionRecord): void {
		try {
			ensureSessionDir();
			fs.appendFileSync(sessionFile, `${JSON.stringify(record)}\n`, "utf-8");
		} catch {
			/* skip */
		}
	}

	function clearSessions(): void {
		try {
			if (fs.existsSync(sessionFile)) {
				fs.unlinkSync(sessionFile);
			}
		} catch {
			/* skip */
		}
	}

	function loadLastSession(): string | null {
		try {
			if (!fs.existsSync(sessionFile)) return null;
			const content = fs.readFileSync(sessionFile, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			if (lines.length === 0) return null;
			const recent = lines.slice(-3).map((l) => JSON.parse(l) as SessionRecord);
			const parts = recent.map(
				(s) => `用户: ${s.userInput}\n玄码: ${s.finalAnswer.slice(0, 500)}`,
			);
			return parts.join("\n\n");
		} catch {
			return null;
		}
	}

	return { saveSession, clearSessions, loadLastSession };
}

// ===== 对话摘要 =====

/** 将消息历史转为文本摘要，避免原始 Message[] 干扰 taorLoop 的停止条件 */
export function buildConversationSummarySimple(messages: Message[]): string {
	if (messages.length === 0) return "";
	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user" && !msg.content.startsWith("工具结果:")) {
			parts.push(`用户: ${msg.content.slice(0, 500)}`);
		} else if (msg.role === "assistant") {
			parts.push(`玄码: ${msg.content.slice(0, 1000)}`);
		}
	}
	return parts.join("\n").slice(0, 4000);
}
