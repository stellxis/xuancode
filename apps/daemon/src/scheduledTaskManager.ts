/**
 * ScheduledTaskManager — 定时任务调度引擎
 *
 * 独立于 DaemonScheduler 运行：
 * 1. 每 60 秒轮询 scheduled_tasks 表
 * 2. 到期任务通过 scheduler.submit() 派发
 * 3. 叠浪防护：同 ID 有 running/queued 任务则跳过
 * 4. 失败重试：onTaskFailed 设置 next_retry_at
 * 5. 自动清理 30 天前的历史记录
 */
import {
	type ScheduledTaskStore,
	getNextRunTime,
	parseCron,
} from "@xuancode/database";
import type { ScheduledTaskRow, TaskStoreSQLite } from "@xuancode/database";

const POLL_INTERVAL_MS = 60_000;
const HISTORY_RETENTION_DAYS = 30;

export interface RetryPolicy {
	intervals: number[]; // 各次重试间隔 (ms)，如 [60000, 300000, 900000]
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
	intervals: [60_000, 300_000, 900_000],
};

export class ScheduledTaskManager {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;

	constructor(
		private store: ScheduledTaskStore,
		private taskStore: TaskStoreSQLite,
		private submitTask: (
			input: string,
			config: any,
			meta?: { scheduledTaskId?: string },
		) => string | null,
	) {}

	start(pollIntervalMs = POLL_INTERVAL_MS): void {
		if (this.running) return;
		this.running = true;
		this.timer = setInterval(() => this.tick(), pollIntervalMs);
		// 立即执行一次检查
		setImmediate(() => this.tick());
	}

	stop(): void {
		this.running = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private tick(): void {
		try {
			const now = new Date().toISOString();
			const due = this.store.listDue(now);

			for (const task of due) {
				if (task.next_retry_at && task.next_retry_at <= now) {
					// 重试到期
					this.dispatchRetry(task);
				} else {
					// 正常调度到期
					this.dispatchScheduled(task);
				}
			}

			// 定期清理历史
			this.cleanupOldHistory();
		} catch (err) {
			console.error("[ScheduledTaskManager] tick error:", err);
		}
	}

	private dispatchScheduled(task: ScheduledTaskRow): void {
		// 叠浪防护：同 ID 有 running/queued 则跳过
		if (this.store.getRunningCount(task.id) > 0) {
			console.log(
				`[ScheduledTaskManager] skip ${task.name} (${task.id}): already running`,
			);
			return;
		}

		this.runOnce(task, false);
	}

	/**
	 * 立即手动触发一次执行。绕过叠浪防护（用户明确要求），但会更新
	 * last_run_at 和 next_run_at。返回新提交的任务 ID，失败返回 null。
	 */
	triggerNow(taskId: string): string | null {
		const task = this.store.get(taskId);
		if (!task) {
			console.warn(
				`[ScheduledTaskManager] triggerNow: task ${taskId} not found`,
			);
			return null;
		}
		return this.runOnce(task, true);
	}

	/**
	 * 执行一次任务。bypassOverlap=true 时跳过叠浪检查（手动触发）。
	 * 返回新提交的任务 ID，失败返回 null。
	 */
	private runOnce(
		task: ScheduledTaskRow,
		bypassOverlap: boolean,
	): string | null {
		if (!bypassOverlap && this.store.getRunningCount(task.id) > 0) {
			console.log(
				`[ScheduledTaskManager] skip ${task.name} (${task.id}): already running`,
			);
			return null;
		}

		const taskId = this.submitTask(
			task.user_input,
			task.config_json ? JSON.parse(task.config_json) : undefined,
			{ scheduledTaskId: task.id },
		);
		if (!taskId) return null;

		// 关联 scheduled_task_id（DB）
		try {
			this.taskStore.saveTask({ id: taskId, scheduledTaskId: task.id } as any);
		} catch {
			// saveTask 是 upsert，忽略部分更新错误
		}

		// 更新执行时间
		const now = new Date().toISOString();
		const fields = parseCron(task.cron_expression);
		const nextRun = fields ? getNextRunTime(fields) : null;
		const nextRunIso = nextRun ? new Date(nextRun).toISOString() : null;
		this.store.updateRunTimes(task.id, now, nextRunIso);

		console.log(
			`[ScheduledTaskManager] ${bypassOverlap ? "triggered" : "dispatched"} ${task.name} → task ${taskId}, next run: ${nextRunIso ?? "never"}`,
		);
		return taskId;
	}

	private dispatchRetry(task: ScheduledTaskRow): void {
		const taskId = this.submitTask(
			task.user_input,
			task.config_json ? JSON.parse(task.config_json) : undefined,
			{ scheduledTaskId: task.id },
		);
		if (!taskId) return;

		// 关联 scheduled_task_id（DB）
		try {
			this.taskStore.saveTask({ id: taskId, scheduledTaskId: task.id } as any);
		} catch {
			// ignore partial update errors
		}

		// 清除重试标记
		this.store.updateRetry(task.id, 0, null);

		console.log(`[ScheduledTaskManager] retry ${task.name} → task ${taskId}`);
	}

	/**
	 * 任务失败时由 daemon 调用 — 设置重试时间
	 */
	onTaskFailed(
		scheduledTaskId: string,
		currentRetryCount: number,
		maxRetries: number,
		retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
	): void {
		if (currentRetryCount >= maxRetries) {
			console.log(
				`[ScheduledTaskManager] ${scheduledTaskId} exhausted ${maxRetries} retries`,
			);
			return;
		}

		const idx = Math.min(currentRetryCount, retryPolicy.intervals.length - 1);
		const delayMs = retryPolicy.intervals[idx];
		const nextRetryAt = new Date(Date.now() + delayMs).toISOString();

		this.store.updateRetry(scheduledTaskId, currentRetryCount + 1, nextRetryAt);
		console.log(
			`[ScheduledTaskManager] will retry ${scheduledTaskId} in ${delayMs}ms (attempt ${currentRetryCount + 1}/${maxRetries})`,
		);
	}

	private cleanupOldHistory(): void {
		const cutoff = new Date(
			Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
		).toISOString();
		const deleted = this.store.cleanupHistory(cutoff);
		if (deleted > 0) {
			console.log(
				`[ScheduledTaskManager] cleaned ${deleted} old history records`,
			);
		}
	}
}
