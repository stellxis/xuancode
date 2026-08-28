/**
 * TaskStoreSQLite — SQLite 实现的 daemon 任务持久化
 *
 * 将 DaemonScheduler 中的内存任务持久化到 daemon_tasks 表，
 * 支持断点恢复和长周期执行。
 */

import type Database from "better-sqlite3";

export interface TaskRow {
	id: string;
	user_id: string | null;
	user_input: string;
	config_json: string | null;
	status: string;
	created_at: string;
	started_at: string | null;
	completed_at: string | null;
	current_turn: number | null;
	current_tool_call: string | null;
	progress_summary: string | null;
	result_json: string | null;
	error: string | null;
	permission_level: string | null;
	review_result_json: string | null;
	awaiting_since: number | null;
	pending_question: string | null;
	intervention_count: number | null;
	scheduled_task_id: string | null;
	session_id: string | null;
}

export class TaskStoreSQLite {
	private db: Database.Database;
	private prepared: {
		upsert: ReturnType<Database.Database["prepare"]>;
		getById: ReturnType<Database.Database["prepare"]>;
		listByStatus: ReturnType<Database.Database["prepare"]>;
		listRecoverable: ReturnType<Database.Database["prepare"]>;
		updateStatus: ReturnType<Database.Database["prepare"]>;
		updateReview: ReturnType<Database.Database["prepare"]>;
		updateProgress: ReturnType<Database.Database["prepare"]>;
	};

	constructor(db: Database.Database) {
		this.db = db;
		this.prepared = {
			upsert: db.prepare(`
        INSERT INTO daemon_tasks (id, user_id, user_input, config_json, status,
          created_at, started_at, completed_at, current_turn, current_tool_call,
          progress_summary, result_json, error, permission_level, review_result_json,
          awaiting_since, pending_question, intervention_count, scheduled_task_id, session_id)
        VALUES (@id, @user_id, @user_input, @config_json, @status,
          @created_at, @started_at, @completed_at, @current_turn, @current_tool_call,
          @progress_summary, @result_json, @error, @permission_level, @review_result_json,
          @awaiting_since, @pending_question, @intervention_count, @scheduled_task_id, @session_id)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          started_at = COALESCE(excluded.started_at, daemon_tasks.started_at),
          completed_at = COALESCE(excluded.completed_at, daemon_tasks.completed_at),
          current_turn = COALESCE(excluded.current_turn, daemon_tasks.current_turn),
          current_tool_call = COALESCE(excluded.current_tool_call, daemon_tasks.current_tool_call),
          progress_summary = COALESCE(excluded.progress_summary, daemon_tasks.progress_summary),
          result_json = COALESCE(excluded.result_json, daemon_tasks.result_json),
          error = COALESCE(excluded.error, daemon_tasks.error),
          review_result_json = COALESCE(excluded.review_result_json, daemon_tasks.review_result_json),
          awaiting_since = COALESCE(excluded.awaiting_since, daemon_tasks.awaiting_since),
          pending_question = COALESCE(excluded.pending_question, daemon_tasks.pending_question),
          intervention_count = COALESCE(excluded.intervention_count, daemon_tasks.intervention_count),
          scheduled_task_id = COALESCE(excluded.scheduled_task_id, daemon_tasks.scheduled_task_id)
      `),
			getById: db.prepare("SELECT * FROM daemon_tasks WHERE id = ?"),
			listByStatus: db.prepare(
				"SELECT * FROM daemon_tasks WHERE status = ? ORDER BY created_at ASC",
			),
			listRecoverable: db.prepare(
				"SELECT * FROM daemon_tasks WHERE status IN ('queued', 'running') ORDER BY created_at ASC",
			),
			updateStatus: db.prepare(`
        UPDATE daemon_tasks SET status = @status, completed_at = @completed_at,
          result_json = @result_json, error = @error
        WHERE id = @id
      `),
			updateReview: db.prepare(
				"UPDATE daemon_tasks SET review_result_json = @review WHERE id = @id",
			),
			updateProgress: db.prepare(`
        UPDATE daemon_tasks SET current_turn = @turn, current_tool_call = @tool_call,
          progress_summary = @summary WHERE id = @id
      `),
		};
	}

	saveTask(task: {
		id: string;
		userId?: string;
		userInput: string;
		config?: any;
		status: string;
		createdAt: string;
		startedAt?: string;
		completedAt?: string;
		currentTurn?: number;
		currentToolCall?: string;
		progressSummary?: string;
		result?: any;
		error?: string;
		userPermissionLevel?: string;
		reviewResult?: string;
		awaitingSince?: number;
		pendingQuestion?: string;
		interventionCount?: number;
		scheduledTaskId?: string;
		sessionId?: string;
	}): void {
		this.prepared.upsert.run({
			id: task.id,
			user_id: task.userId || null,
			user_input: task.userInput,
			config_json: task.config ? JSON.stringify(task.config) : null,
			status: task.status,
			created_at: task.createdAt,
			started_at: task.startedAt || null,
			completed_at: task.completedAt || null,
			current_turn: task.currentTurn ?? null,
			current_tool_call: task.currentToolCall || null,
			progress_summary: task.progressSummary || null,
			result_json: task.result ? JSON.stringify(task.result) : null,
			error: task.error || null,
			permission_level: task.userPermissionLevel || null,
			review_result_json: task.reviewResult || null,
			awaiting_since: task.awaitingSince ?? null,
			pending_question: task.pendingQuestion || null,
			intervention_count: task.interventionCount ?? null,
			scheduled_task_id: task.scheduledTaskId || null,
			session_id: task.sessionId || null,
		});
	}

	getTask(id: string): TaskRow | undefined {
		return this.prepared.getById.get(id) as TaskRow | undefined;
	}

	listTasks(status?: string, limit = 50, offset = 0): TaskRow[] {
		if (status) {
			return this.db
				.prepare(
					"SELECT * FROM daemon_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
				)
				.all(status, limit, offset) as TaskRow[];
		}
		return this.db
			.prepare(
				"SELECT * FROM daemon_tasks ORDER BY created_at DESC LIMIT ? OFFSET ?",
			)
			.all(limit, offset) as TaskRow[];
	}

	getRecoverableTasks(): TaskRow[] {
		return (
			this.prepared.listRecoverable.all as (...args: any[]) => any[]
		)() as TaskRow[];
	}

	updateTaskStatus(
		id: string,
		status: string,
		result?: any,
		error?: string,
	): void {
		this.prepared.updateStatus.run({
			id,
			status,
			completed_at:
				status === "completed" || status === "failed"
					? new Date().toISOString()
					: null,
			result_json: result ? JSON.stringify(result) : null,
			error: error || null,
		});
	}

	updateTaskReview(id: string, reviewResult: string): void {
		this.prepared.updateReview.run({ id, review: reviewResult });
	}
}
