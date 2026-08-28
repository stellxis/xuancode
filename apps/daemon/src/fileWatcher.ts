import path from "node:path";
import { subscribe } from "@parcel/watcher";

export type FileChangeType = "created" | "modified" | "deleted";

export interface FileChangeEvent {
	type: FileChangeType;
	filePath: string;
	timestamp: number;
}

type ChangeCallback = (events: FileChangeEvent[]) => void;

/**
 * File system watcher backed by @parcel/watcher (Rust native).
 *
 * Design:
 * - Uses @parcel/watcher's subscribe() which delegates to the best OS backend
 *   (FSEvents on macOS, inotify on Linux, ReadDirectoryChangesW on Windows).
 * - Events are coalesced by the native layer: create+update → create,
 *   create+delete → no event, one event per file.
 * - A 500ms debounce window batches rapid events into a single callback.
 * - A ring buffer holds the last 2000 events for REST polling (getChangesSince).
 */
export class FileWatcher {
	private subscription: { unsubscribe: () => Promise<void> } | null = null;
	private callback: ChangeCallback | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private pending: FileChangeEvent[] = [];
	private watchedDir = "";

	/** Ring buffer of recent file change events (for REST polling) */
	private eventHistory: FileChangeEvent[] = [];
	private readonly MAX_HISTORY = 2000;
	private historyHead = 0;
	private historyCount = 0;

	/** Glob patterns passed to @parcel/watcher (native-level filtering) */
	private readonly IGNORE_GLOBS = [
		"**/node_modules/**",
		"**/.git/**",
		"**/.svn/**",
		"**/.hg/**",
		"**/.next/**",
		"**/dist/**",
		"**/build/**",
		"**/.turbo/**",
		"**/.cache/**",
		"**/coverage/**",
		"**/.nx/**",
		"**/.yarn/**",
	];

	/** Secondary regex filter for edge cases not covered by globs */
	private readonly IGNORE_PATTERNS = [
		/[/\\]node_modules[/\\]/,
		/[/\\]\.git[/\\]/,
		/[/\\]\.next[/\\]/,
		/[/\\]dist[/\\]/,
		/[/\\]\.turbo[/\\]/,
		/[/\\]\.cache[/\\]/,
		/[/\\]coverage[/\\]/,
	];

	startWatch(dir: string, cb: ChangeCallback): void {
		void this.stopWatch();
		this.watchedDir = dir;
		this.callback = cb;
		this.pending = [];

		subscribe(
			dir,
			(err, events) => {
				if (err) {
					console.error("[fileWatcher] @parcel/watcher error:", err);
					return;
				}
				for (const event of events) {
					// Secondary filter for safety (primary is IGNORE_GLOBS at native level)
					if (this.IGNORE_PATTERNS.some((p) => p.test(event.path))) continue;

					const basename = path.basename(event.path);
					if (
						basename.startsWith(".") ||
						basename.endsWith("~") ||
						basename.endsWith(".swp") ||
						basename.endsWith(".swx")
					) {
						continue;
					}

					let changeType: FileChangeType;
					switch (event.type) {
						case "create":
							changeType = "created";
							break;
						case "update":
							changeType = "modified";
							break;
						case "delete":
							changeType = "deleted";
							break;
					}

					this.pending.push({
						type: changeType,
						filePath: event.path,
						timestamp: Date.now(),
					});
					this.debounceEmit();
				}
			},
			{ ignore: this.IGNORE_GLOBS },
		)
			.then((sub) => {
				this.subscription = sub;
			})
			.catch((err) => {
				console.error(`[fileWatcher] Failed to watch ${dir}:`, err);
			});
	}

	/** 停止监听并等待原生后端（@parcel/watcher）完全关闭 —— 调用方应 await，避免硬杀 worker 时中断原生回调 */
	stopWatch(): Promise<void> {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		const sub = this.subscription;
		this.subscription = null;

		this.pending = [];
		this.watchedDir = "";
		this.eventHistory = [];
		this.historyHead = 0;
		this.historyCount = 0;

		if (!sub) return Promise.resolve();
		return sub.unsubscribe().catch(() => {});
	}

	/** Get the directory currently being watched */
	getWatchedDir(): string {
		return this.watchedDir;
	}

	/** Get changes since a given timestamp (for REST polling) */
	getChangesSince(timestamp: number): FileChangeEvent[] {
		if (this.historyCount === 0) return [];
		const result: FileChangeEvent[] = [];
		const start = this.historyCount < this.MAX_HISTORY ? 0 : this.historyHead;
		const count = this.historyCount;
		for (let i = 0; i < count; i++) {
			const evt = this.eventHistory[(start + i) % this.MAX_HISTORY];
			if (evt && evt.timestamp > timestamp) {
				result.push(evt);
			}
		}
		return result;
	}

	private debounceEmit(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			if (this.pending.length > 0 && this.callback) {
				const batch = [...this.pending];
				for (const evt of batch) {
					this.eventHistory[this.historyHead] = evt;
					this.historyHead = (this.historyHead + 1) % this.MAX_HISTORY;
					if (this.historyCount < this.MAX_HISTORY) this.historyCount++;
				}
				this.callback(batch);
				this.pending = [];
			}
		}, 500);
	}
}
