/**
 * eventStream — 追加式系统事件流（跨会话审计/回放）
 *
 * 记录插件生命周期、任务、会话等全局系统事件到 <workDir>/.xuancode/events.jsonl，
 * 超过 maxLogSize 自动轮转。与 @xuancode/session 的 per-session JSONL 互补：
 * 前者是单个会话内部细节，这里是跨会话的系统级事实。
 */

import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

export type SystemEventType =
	| "plugin_loaded"
	| "plugin_unloaded"
	| "plugin_load_failed"
	| "plugin_destroy_error"
	| "session_started"
	| "session_ended"
	| "task_created"
	| "task_completed"
	| "error";

export interface SystemEvent {
	ts: string;
	type: SystemEventType;
	payload: Record<string, unknown>;
}

export class EventStream {
	private filePath: string;
	private maxLogSize: number;

	constructor(dir: string, maxLogSize = 10 * 1024 * 1024) {
		this.filePath = path.join(dir, "events.jsonl");
		this.maxLogSize = maxLogSize;
	}

	async init(): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true });
	}

	async append(
		type: SystemEventType,
		payload: Record<string, unknown> = {},
	): Promise<void> {
		try {
			const st = await stat(this.filePath);
			if (st.size > this.maxLogSize) {
				await rename(this.filePath, `${this.filePath}.${Date.now()}.rotated`);
			}
		} catch {
			// 首次写入，文件尚不存在
		}
		const entry: SystemEvent = { ts: new Date().toISOString(), type, payload };
		await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
	}

	async readAll(limit = 500): Promise<SystemEvent[]> {
		const entries: SystemEvent[] = [];
		let files: string[];
		try {
			files = await readdir(path.dirname(this.filePath));
		} catch {
			return entries;
		}
		const rotated = files
			.filter((f) => f.startsWith("events.jsonl.") && f.endsWith(".rotated"))
			.sort();
		for (const file of [...rotated, "events.jsonl"]) {
			const filePath = path.join(path.dirname(this.filePath), file);
			const rl = readline.createInterface({
				input: createReadStream(filePath),
				crlfDelay: Number.POSITIVE_INFINITY,
			});
			for await (const line of rl) {
				try {
					entries.push(JSON.parse(line));
				} catch {
					// 跳过损坏行
				}
				if (entries.length >= limit) return entries;
			}
		}
		return entries;
	}
}
