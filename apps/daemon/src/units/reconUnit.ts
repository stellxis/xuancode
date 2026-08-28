import { FileWatcher } from "../fileWatcher.js";
import { UnitBase } from "./UnitBase.js";
import type { ReconStatus } from "./channel.js";

class ReconUnit extends UnitBase {
	protected readonly unitName = "RECON";

	private fileWatcher = new FileWatcher();

	constructor() {
		super();

		this.onCommand("start_watch", async (payload: any) => {
			const dir: string = payload?.dir;
			if (!dir) {
				console.error("[RECON] start_watch: missing dir");
				return;
			}
			this.fileWatcher.startWatch(dir, (events) => {
				// Deduplicate: merge consecutive events for the same file
				const deduped = this.deduplicateEvents(events);
				this.sendEvent("file_changed", { events: deduped });
			});
			this.sendEvent("watcher_status", { watching: true, dir });
			console.error(`[RECON] Watching: ${dir}`);
		});

		this.onCommand("stop_watch", async () => {
			await this.fileWatcher.stopWatch();
			this.sendEvent("watcher_status", { watching: false });
			console.error("[RECON] Stopped watching");
		});

		// 优雅关闭：等原生 watcher 完全卸载后再放行 terminate，避免硬杀中断原生回调导致进程级 SIGSEGV
		this.onRequest("close", async () => {
			await this.fileWatcher.stopWatch();
			return { success: true };
		});

		this.onRequest("get_changes_since", async (params: any) => {
			const since = typeof params === "number" ? params : (params?.since ?? 0);
			return { changes: this.fileWatcher.getChangesSince(since) };
		});

		this.onRequest("get_status", async () => {
			return {
				watching: this.fileWatcher.getWatchedDir() !== "",
				watchedDir: this.fileWatcher.getWatchedDir(),
				uptime: Date.now() - this.startedAt,
			} satisfies ReconStatus;
		});

		this.startHeartbeat();
		console.error("[RECON] Unit initialized");
	}

	private deduplicateEvents(
		events: import("../fileWatcher").FileChangeEvent[],
	): import("../fileWatcher").FileChangeEvent[] {
		if (events.length <= 1) return events;
		const map = new Map<string, import("../fileWatcher").FileChangeEvent>();
		for (const e of events) {
			const existing = map.get(e.filePath);
			if (!existing || e.timestamp > existing.timestamp) {
				map.set(e.filePath, e);
			}
		}
		return Array.from(map.values());
	}
}

new ReconUnit();
