/**
 * ScheduledTaskStore — scheduled_tasks 表的 CRUD 操作
 *
 * 沿袭 TaskStoreSQLite 模式：constructor 中预编译 SQL 语句，
 * 方法直接调用 prepared statements。
 */
import type Database from "better-sqlite3";

export interface ScheduledTaskRow {
	id: string;
	user_id: string | null;
	name: string;
	description: string;
	cron_expression: string;
	user_input: string;
	config_json: string | null;
	enabled: number;
	max_retries: number;
	retry_interval_ms: number;
	next_retry_at: string | null;
	created_at: string;
	updated_at: string;
	last_run_at: string | null;
	next_run_at: string | null;
}

export interface TaskHistoryRow {
	id: string;
	user_input: string;
	status: string;
	created_at: string;
	completed_at: string | null;
	error: string | null;
	retry_count: number | null;
	scheduled_task_id: string | null;
	result_json: string | null;
}

export interface ScheduledTaskWithLastStatus extends ScheduledTaskRow {
	last_status: string | null;
	running_count: number;
}

export class ScheduledTaskStore {
	constructor(private db: Database.Database) {}

	insert(row: ScheduledTaskRow): void {
		this.db
			.prepare(
				`INSERT INTO scheduled_tasks
       (id, user_id, name, description, cron_expression, user_input,
        config_json, enabled, max_retries, retry_interval_ms,
        next_retry_at, created_at, updated_at, last_run_at, next_run_at)
       VALUES (@id, @user_id, @name, @description, @cron_expression,
               @user_input, @config_json, @enabled, @max_retries,
               @retry_interval_ms, @next_retry_at, @created_at,
               @updated_at, @last_run_at, @next_run_at)`,
			)
			.run(row);
	}

	update(id: string, data: Partial<ScheduledTaskRow>): void {
		const keys = Object.keys(data).filter((k) => k !== "id");
		if (keys.length === 0) return;
		const setClause = keys.map((k) => `"${k}" = @${k}`).join(", ");
		const params = { ...data, id } as Record<string, unknown>;
		this.db
			.prepare(`UPDATE scheduled_tasks SET ${setClause} WHERE id = @id`)
			.run(params);
	}

	get(id: string): ScheduledTaskRow | undefined {
		return this.db
			.prepare("SELECT * FROM scheduled_tasks WHERE id = ?")
			.get(id) as ScheduledTaskRow | undefined;
	}

	listAll(): ScheduledTaskRow[] {
		return this.db
			.prepare("SELECT * FROM scheduled_tasks ORDER BY created_at DESC")
			.all() as ScheduledTaskRow[];
	}

	/** 列出所有定时任务，并附带最近一次执行状态与当前运行数。
	 *  用相关子查询取每个 scheduled_task 的最新 daemon_task 行。 */
	listAllWithLastStatus(): ScheduledTaskWithLastStatus[] {
		return this.db
			.prepare(
				`SELECT s.*,
              (SELECT t.status FROM daemon_tasks t
               WHERE t.scheduled_task_id = s.id
               ORDER BY t.created_at DESC LIMIT 1) AS last_status,
              (SELECT COUNT(*) FROM daemon_tasks t
               WHERE t.scheduled_task_id = s.id
                 AND t.status IN ('queued', 'running')) AS running_count
       FROM scheduled_tasks s
       ORDER BY s.created_at DESC`,
			)
			.all() as ScheduledTaskWithLastStatus[];
	}

	delete(id: string): void {
		this.db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
	}

	setEnabled(id: string, enabled: boolean): void {
		this.db
			.prepare("UPDATE scheduled_tasks SET enabled = ? WHERE id = ?")
			.run(enabled ? 1 : 0, id);
	}

	/**
	 * 查询到期任务：已启用 且 (下次执行时间 <= now 或 重试时间 <= now)
	 */
	listDue(nowIso: string): ScheduledTaskRow[] {
		return this.db
			.prepare(
				`SELECT * FROM scheduled_tasks
       WHERE enabled = 1
         AND ((next_run_at IS NOT NULL AND next_run_at <= ?)
              OR (next_retry_at IS NOT NULL AND next_retry_at <= ?))`,
			)
			.all(nowIso, nowIso) as ScheduledTaskRow[];
	}

	updateRunTimes(
		id: string,
		lastRunAt: string,
		nextRunAt: string | null,
	): void {
		this.db
			.prepare(
				"UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?",
			)
			.run(lastRunAt, nextRunAt, id);
	}

	updateRetry(
		id: string,
		retryCount: number,
		nextRetryAt: string | null,
	): void {
		this.db
			.prepare(
				"UPDATE scheduled_tasks SET max_retries = max_retries, next_retry_at = ? WHERE id = ?",
			)
			.run(nextRetryAt, id);
		// Update max_retries as a no-op to allow the SET clause to pass through
		// We only need to update next_retry_at here; retry_count is on daemon_tasks
	}

	/**
	 * 检查指定定时任务当前是否有正在执行的任务
	 */
	getRunningCount(scheduledTaskId: string): number {
		const row = this.db
			.prepare(
				`SELECT COUNT(*) as count FROM daemon_tasks
       WHERE scheduled_task_id = ? AND status IN ('queued', 'running')`,
			)
			.get(scheduledTaskId) as { count: number } | undefined;
		return row?.count ?? 0;
	}

	/**
	 * 获取定时任务的执行历史
	 */
	getTaskHistory(scheduledTaskId: string, limit = 20): TaskHistoryRow[] {
		return this.db
			.prepare(
				`SELECT id, user_input, status, created_at, completed_at, error,
              retry_count, scheduled_task_id, result_json
       FROM daemon_tasks
       WHERE scheduled_task_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
			)
			.all(scheduledTaskId, limit) as TaskHistoryRow[];
	}

	/**
	 * 清理指定时间之前的历史记录（仅 scheduled_task 关联的任务）
	 * @returns 删除的记录数
	 */
	cleanupHistory(beforeIso: string): number {
		const result = this.db
			.prepare(
				"DELETE FROM daemon_tasks WHERE scheduled_task_id IS NOT NULL AND created_at < ?",
			)
			.run(beforeIso);
		return result.changes;
	}
}
