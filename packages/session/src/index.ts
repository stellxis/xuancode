import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { AgentConfig, Message, StopReason } from "@xuancode/types";
import { resolveProjectData } from "@xuancode/utils";

/**
 * 会话目录布局（v2）：
 *   <sessionsDir>/<sessionId>/transcript.jsonl   事实源
 *   <sessionsDir>/<sessionId>/memory-session.md  L6 会话记忆
 * 兼容旧布局（v1）：<sessionsDir>/<sessionId>.jsonl（迁移由 @xuancode/utils migrateProjectData 完成，
 * 读取侧双兼容：新路径优先，回退旧平铺文件）。
 */
const TRANSCRIPT_FILE = "transcript.jsonl";

/** 解析会话 transcript 路径：目录化优先，回退旧平铺 jsonl */
export function resolveTranscriptPath(
	sessionsDir: string,
	sessionId: string,
): string {
	const v2 = path.join(sessionsDir, sessionId, TRANSCRIPT_FILE);
	if (existsSync(v2)) return v2;
	return path.join(sessionsDir, `${sessionId}.jsonl`);
}

// ===== 日志条目类型 =====

export interface SessionMeta {
	type: "session_meta";
	sessionId: string;
	createdAt: string;
	config: Partial<AgentConfig>;
	userInput: string;
}

export interface SessionEndEntry {
	type: "session_end";
	duration: number;
	turnCount: number;
	toolCallCount: number;
	errorCount: number;
	stopReason: StopReason;
	finalAnswer: string;
	contextUsage: number;
}

export interface MessageEntry {
	type: "message";
	message: Message;
	turn: number;
}

export interface ToolCallEntry {
	type: "tool_call";
	turn: number;
	toolCall: {
		type: string;
		path?: string;
		content?: string;
		command?: string;
		pattern?: string;
	};
	result: {
		success: boolean;
		data?: string;
		error?: string;
		duration?: number;
	};
}

export interface ErrorEntry {
	type: "error";
	turn: number;
	site: string;
	message: string;
	recoverable: boolean;
}

export interface CompactEntry {
	type: "compact";
	turn: number;
	level: number;
	beforeCount: number;
	afterCount: number;
}

export type LogEntry =
	| SessionMeta
	| SessionEndEntry
	| MessageEntry
	| ToolCallEntry
	| ErrorEntry
	| CompactEntry;

// ===== 会话存储 =====

export class SessionStore {
	private sessionDir: string;
	private sessionId: string;
	private logPath: string;
	private createdAt: string;
	private maxLogSize: number;
	private rotateCounter = 0;

	constructor(
		sessionDirOrOptions?: string | { sessionDir?: string; maxLogSize?: number },
	) {
		const defaultDir = path.join(resolveProjectData(process.cwd()), "sessions");
		if (typeof sessionDirOrOptions === "object") {
			this.sessionDir = sessionDirOrOptions.sessionDir || defaultDir;
			this.maxLogSize = sessionDirOrOptions.maxLogSize ?? 10 * 1024 * 1024;
		} else {
			this.sessionDir = sessionDirOrOptions || defaultDir;
			this.maxLogSize = 10 * 1024 * 1024;
		}
		this.sessionId = new Date().toISOString().replace(/[:.]/g, "-");
		this.createdAt = new Date().toISOString();
		// v2 目录化：每个会话一个子目录，transcript.jsonl 为事实源
		this.logPath = path.join(this.sessionDir, this.sessionId, TRANSCRIPT_FILE);
	}

	async init(): Promise<void> {
		await fs.mkdir(path.dirname(this.logPath), { recursive: true });
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getLogPath(): string {
		return this.logPath;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	/** 会话专属目录（L6 会话记忆 memory-session.md / L7 subagent-memory.md 存放处） */
	getMemoryDir(): string {
		return path.dirname(this.logPath);
	}

	/** 添加任意日志条目（自动轮转） */
	async append(entry: LogEntry): Promise<void> {
		try {
			const stat = await fs.stat(this.logPath);
			if (stat.size > this.maxLogSize) {
				this.rotateCounter++;
				const rotatedPath = `${this.logPath}.${this.rotateCounter}.rotated`;
				await fs.rename(this.logPath, rotatedPath);
			}
		} catch {
			// File doesn't exist yet — first write
		}
		await fs.appendFile(this.logPath, `${JSON.stringify(entry)}\n`, "utf-8");
	}

	/** 写入会话元数据（第一条） */
	async writeMeta(
		config: Partial<AgentConfig>,
		userInput: string,
	): Promise<void> {
		await this.append({
			type: "session_meta",
			sessionId: this.sessionId,
			createdAt: this.createdAt,
			config,
			userInput,
		});
	}

	/** 写入会话结束记录 */
	async writeEnd(result: {
		duration: number;
		turnCount: number;
		toolCallCount: number;
		errorCount: number;
		stopReason: StopReason;
		finalAnswer: string;
		contextUsage: number;
	}): Promise<void> {
		await this.append({ type: "session_end", ...result });
	}

	/** 记录一条消息 */
	async logMessage(message: Message, turn: number): Promise<void> {
		await this.append({ type: "message", message, turn });
	}

	/** 记录一次工具调用 */
	async logToolCall(
		turn: number,
		toolCall: ToolCallEntry["toolCall"],
		result: ToolCallEntry["result"],
	): Promise<void> {
		await this.append({ type: "tool_call", turn, toolCall, result });
	}

	/** 记录一个错误 */
	async logError(
		turn: number,
		site: string,
		message: string,
		recoverable: boolean,
	): Promise<void> {
		await this.append({ type: "error", turn, site, message, recoverable });
	}

	/** 记录一次上下文压缩 */
	async logCompact(
		turn: number,
		level: number,
		beforeCount: number,
		afterCount: number,
	): Promise<void> {
		await this.append({
			type: "compact",
			turn,
			level,
			beforeCount,
			afterCount,
		});
	}

	// ===== 读取与恢复 =====

	/** 从单个 JSONL 文件读取条目 */
	private async readFileEntries(filePath: string): Promise<LogEntry[]> {
		if (!existsSync(filePath)) return [];
		const entries: LogEntry[] = [];
		const rl = readline.createInterface({
			input: createReadStream(filePath),
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		for await (const line of rl) {
			try {
				entries.push(JSON.parse(line));
			} catch {
				/* skip malformed */
			}
		}
		return entries;
	}

	/** 读取全部日志条目（包含轮转文件） */
	async readAll(): Promise<LogEntry[]> {
		const entries: LogEntry[] = [];
		// Read rotated files first (in chronological order)
		const dir = path.dirname(this.logPath);
		const baseName = path.basename(this.logPath, ".jsonl");
		try {
			const files = await fs.readdir(dir);
			const rotatedFiles = files
				.filter((f) => f.startsWith(baseName) && f.endsWith(".rotated"))
				.sort();
			for (const file of rotatedFiles) {
				entries.push(...(await this.readFileEntries(path.join(dir, file))));
			}
		} catch {
			/* no rotated dir */
		}
		// Read current log
		entries.push(...(await this.readFileEntries(this.logPath)));
		return entries;
	}

	/** 从日志重建消息列表（用于恢复会话） */
	async rebuildMessages(): Promise<Message[]> {
		const entries = await this.readAll();
		return entries
			.filter((e): e is MessageEntry => e.type === "message")
			.map((e) => e.message);
	}

	/** 提取所有工具调用记录（用于审计回放） */
	async getAuditTrail(): Promise<ToolCallEntry[]> {
		const entries = await this.readAll();
		return entries.filter((e): e is ToolCallEntry => e.type === "tool_call");
	}

	/** 获取会话摘要 */
	async getSummary(): Promise<{
		meta?: SessionMeta;
		end?: SessionEndEntry;
		messageCount: number;
		toolCallCount: number;
		errorCount: number;
	}> {
		const entries = await this.readAll();
		const meta = entries.find(
			(e): e is SessionMeta => e.type === "session_meta",
		);
		const end = entries.find(
			(e): e is SessionEndEntry => e.type === "session_end",
		);
		return {
			meta,
			end,
			messageCount: entries.filter((e) => e.type === "message").length,
			toolCallCount: entries.filter((e) => e.type === "tool_call").length,
			errorCount: entries.filter((e) => e.type === "error").length,
		};
	}
}

// ===== 会话管理器 =====

export class SessionManager {
	private sessionsDir: string;
	private maxLogSize: number;

	constructor(
		sessionsDirOrOptions?:
			| string
			| { sessionsDir?: string; maxLogSize?: number },
	) {
		const defaultDir = path.join(resolveProjectData(process.cwd()), "sessions");
		if (typeof sessionsDirOrOptions === "object") {
			this.sessionsDir = sessionsDirOrOptions.sessionsDir || defaultDir;
			this.maxLogSize = sessionsDirOrOptions.maxLogSize ?? 10 * 1024 * 1024;
		} else {
			this.sessionsDir = sessionsDirOrOptions || defaultDir;
			this.maxLogSize = 10 * 1024 * 1024;
		}
	}

	/** 清理超过指定天数的旧会话（v2 目录与 v1 平铺文件双兼容） */
	async pruneSessions(maxAgeDays: number): Promise<number> {
		const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
		let deleted = 0;
		try {
			const entries = await fs.readdir(this.sessionsDir, {
				withFileTypes: true,
			});
			for (const entry of entries) {
				try {
					if (entry.isDirectory()) {
						// v2：会话子目录，按 transcript 的 mtime 判断
						const transcriptPath = path.join(
							this.sessionsDir,
							entry.name,
							TRANSCRIPT_FILE,
						);
						const stat = await fs.stat(transcriptPath);
						if (stat.mtimeMs < cutoff) {
							await fs.rm(path.join(this.sessionsDir, entry.name), {
								recursive: true,
								force: true,
							});
							deleted++;
						}
					} else if (
						entry.name.endsWith(".jsonl") ||
						entry.name.endsWith(".rotated")
					) {
						// v1：平铺文件
						const filePath = path.join(this.sessionsDir, entry.name);
						const stat = await fs.stat(filePath);
						if (stat.mtimeMs < cutoff) {
							await fs.unlink(filePath);
							deleted++;
						}
					}
				} catch {
					/* skip unreadable */
				}
			}
		} catch {
			/* dir doesn't exist */
		}
		return deleted;
	}

	/** 创建新会话 */
	async createSession(
		config: Partial<AgentConfig>,
		userInput: string,
	): Promise<SessionStore> {
		await this.pruneSessions(30);
		const store = new SessionStore({
			sessionDir: this.sessionsDir,
			maxLogSize: this.maxLogSize,
		});
		await store.init();
		await store.writeMeta(config, userInput);
		return store;
	}

	/** 列出所有会话（v2 目录 + v1 平铺双兼容） */
	async listSessions(): Promise<
		Array<{ sessionId: string; createdAt: string; summary: string }>
	> {
		await this.pruneSessions(30);
		await fs.mkdir(this.sessionsDir, { recursive: true }).catch(() => {});
		const entries = await fs
			.readdir(this.sessionsDir, { withFileTypes: true })
			.catch(() => []);

		// 收集会话标识：目录名（v2）+ 平铺 jsonl 文件名（v1），按名称倒序取最近 50
		const sessionIds = Array.from(
			new Set(
				entries
					.map((e) => {
						if (e.isDirectory()) return e.name;
						if (e.name.endsWith(".jsonl"))
							return e.name.replace(/\.jsonl(\.\d+)?(\.rotated)?$/, "");
						return null;
					})
					.filter((n): n is string => n !== null),
			),
		)
			.sort()
			.reverse()
			.slice(0, 50);

		const sessions: Array<{
			sessionId: string;
			createdAt: string;
			summary: string;
		}> = [];

		for (const sessionId of sessionIds) {
			const store = new SessionStore(this.sessionsDir);
			(store as any).sessionId = sessionId;
			(store as any).logPath = resolveTranscriptPath(
				this.sessionsDir,
				sessionId,
			);
			try {
				const summary = await store.getSummary();
				sessions.push({
					sessionId: summary.meta?.sessionId || sessionId,
					createdAt: summary.meta?.createdAt || "unknown",
					summary: summary.end
						? `${summary.end.turnCount} turns, ${summary.end.stopReason}`
						: "incomplete",
				});
			} catch {
				/* skip unreadable */
			}
		}
		return sessions;
	}

	/** 加载已有会话（v2 目录优先，回退 v1 平铺） */
	async loadSession(sessionId: string): Promise<SessionStore> {
		const store = new SessionStore(this.sessionsDir);
		(store as any).sessionId = sessionId;
		(store as any).logPath = resolveTranscriptPath(this.sessionsDir, sessionId);
		return store;
	}
}
