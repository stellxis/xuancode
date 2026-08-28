import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 迁移版本信息 */
export interface Migration {
	version: number;
	description: string;
	sql: string;
}

/** 已应用的迁移记录 */
interface MigrationRecord {
	version: number;
	applied_at: string;
}

/**
 * 内嵌迁移 SQL（当文件系统加载失败时使用，确保在 tsup 打包场景下也能正常建表）
 */
const EMBEDDED_MIGRATIONS: Migration[] = [
	{
		version: 1,
		description: "initial tables",
		sql: [
			"CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, completed_at TEXT, user_input TEXT NOT NULL, config_json TEXT, turn_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, error_count INTEGER DEFAULT 0, stop_reason TEXT, duration_ms INTEGER, final_answer TEXT, context_usage INTEGER, token_usage INTEGER);",
			"CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);",
			"CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);",
			"CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);",
			"CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);",
			"CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, turn INTEGER NOT NULL, role TEXT NOT NULL, content TEXT, tool_call_id TEXT, name TEXT, created_at TEXT NOT NULL);",
			"CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, turn);",
			"CREATE TABLE IF NOT EXISTS tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, turn INTEGER NOT NULL, tool_type TEXT NOT NULL, args_json TEXT NOT NULL, success INTEGER NOT NULL, result_data TEXT, result_error TEXT, duration_ms INTEGER, created_at TEXT NOT NULL);",
			"CREATE INDEX IF NOT EXISTS idx_toolcalls_session ON tool_calls(session_id, turn);",
			"CREATE INDEX IF NOT EXISTS idx_toolcalls_type ON tool_calls(tool_type);",
			"CREATE TABLE IF NOT EXISTS errors (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, turn INTEGER NOT NULL, site TEXT NOT NULL, message TEXT NOT NULL, recoverable INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);",
			"CREATE INDEX IF NOT EXISTS idx_errors_session ON errors(session_id);",
			"CREATE TABLE IF NOT EXISTS compactions (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, turn INTEGER NOT NULL, level INTEGER NOT NULL, before_count INTEGER NOT NULL, after_count INTEGER NOT NULL, created_at TEXT NOT NULL);",
			"CREATE INDEX IF NOT EXISTS idx_compactions_session ON compactions(session_id, turn);",
			"CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'free', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT);",
			"CREATE TABLE IF NOT EXISTS usage_records (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id), date TEXT NOT NULL, task_count INTEGER DEFAULT 0, turn_count INTEGER DEFAULT 0, token_count INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0, UNIQUE(user_id, date));",
			"CREATE TABLE IF NOT EXISTS daemon_tasks (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), user_input TEXT NOT NULL, config_json TEXT, status TEXT NOT NULL DEFAULT 'queued', created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, current_turn INTEGER DEFAULT 0, current_tool_call TEXT, progress_summary TEXT, result_json TEXT, error TEXT);",
			"CREATE INDEX IF NOT EXISTS idx_daemontasks_status ON daemon_tasks(status);",
			"CREATE INDEX IF NOT EXISTS idx_daemontasks_user ON daemon_tasks(user_id);",
		].join("\n"),
	},
	{
		version: 2,
		description: "add task concurrency columns",
		sql: [
			"ALTER TABLE daemon_tasks ADD COLUMN permission_level TEXT DEFAULT 'free';",
			"ALTER TABLE daemon_tasks ADD COLUMN review_result_json TEXT;",
			"ALTER TABLE daemon_tasks ADD COLUMN awaiting_since INTEGER;",
			"ALTER TABLE daemon_tasks ADD COLUMN pending_question TEXT;",
			"ALTER TABLE daemon_tasks ADD COLUMN intervention_count INTEGER DEFAULT 0;",
		].join("\n"),
	},
	{
		version: 3,
		description: "scheduled tasks",
		sql: [
			"CREATE TABLE IF NOT EXISTS scheduled_tasks (id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', cron_expression TEXT NOT NULL, user_input TEXT NOT NULL, config_json TEXT, enabled INTEGER NOT NULL DEFAULT 1, max_retries INTEGER NOT NULL DEFAULT 3, retry_interval_ms INTEGER NOT NULL DEFAULT 60000, next_retry_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_run_at TEXT, next_run_at TEXT);",
			"CREATE INDEX IF NOT EXISTS idx_schedtasks_nextrun ON scheduled_tasks(next_run_at);",
			"CREATE INDEX IF NOT EXISTS idx_schedtasks_enabled ON scheduled_tasks(enabled);",
			"ALTER TABLE daemon_tasks ADD COLUMN scheduled_task_id TEXT;",
			"ALTER TABLE daemon_tasks ADD COLUMN retry_count INTEGER DEFAULT 0;",
			"CREATE INDEX IF NOT EXISTS idx_daemontasks_scheduled ON daemon_tasks(scheduled_task_id);",
		].join("\n"),
	},
	{
		version: 4,
		description: "add session_id to daemon_tasks",
		sql: [
			"ALTER TABLE daemon_tasks ADD COLUMN session_id TEXT;",
			"CREATE INDEX IF NOT EXISTS idx_daemontasks_session ON daemon_tasks(session_id);",
		].join("\n"),
	},
];

/**
 * 迁移管理器
 * 从 migrations/ 目录加载 SQL 文件并按版本顺序执行
 */
export class MigrationManager {
	private db: Database.Database;
	private migrationsDir: string;

	constructor(db: Database.Database, migrationsDir?: string) {
		this.db = db;
		this.migrationsDir = migrationsDir || path.resolve(__dirname, "migrations");
	}

	/** 确保 _migrations 跟踪表存在 */
	private ensureTrackingTable(): void {
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL DEFAULT '',
        applied_at TEXT NOT NULL
      )
    `);
	}

	/** 加载所有可用的迁移文件，回退到内嵌迁移 */
	loadMigrations(): Migration[] {
		const files = this.loadFileMigrations();
		if (files.length > 0) return files;
		return EMBEDDED_MIGRATIONS;
	}

	/** 从文件系统加载迁移 */
	private loadFileMigrations(): Migration[] {
		if (!fs.existsSync(this.migrationsDir)) return [];

		const files = fs
			.readdirSync(this.migrationsDir)
			.filter((f) => f.endsWith(".sql"))
			.sort();

		return files.map((file) => {
			const match = file.match(/^(\d+)_(.+)\.sql$/);
			if (!match)
				throw new Error(
					`Invalid migration filename: ${file} (expected NNN_name.sql)`,
				);
			const version = Number.parseInt(match[1], 10);
			const description = match[2].replace(/_/g, " ");
			const sql = fs.readFileSync(path.join(this.migrationsDir, file), "utf-8");
			return { version, description, sql };
		});
	}

	/** 获取已应用的迁移版本列表 */
	getAppliedVersions(): number[] {
		try {
			const records = this.db
				.prepare("SELECT version FROM _migrations ORDER BY version")
				.all() as MigrationRecord[];
			return records.map((r) => r.version);
		} catch {
			return [];
		}
	}

	/** 执行所有未应用的迁移 */
	migrate(): void {
		this.ensureTrackingTable();
		const applied = new Set(this.getAppliedVersions());
		const migrations = this.loadMigrations();

		const insertStmt = this.db.prepare(
			"INSERT INTO _migrations (version, description, applied_at) VALUES (?, ?, ?)",
		);

		const runMigration = this.db.transaction((m: Migration) => {
			// 逐条语句执行（SQLite 的 exec 只执行单条语句）
			for (const statement of splitStatements(m.sql)) {
				const trimmed = statement.trim();
				if (trimmed) this.db.exec(trimmed);
			}
			insertStmt.run(m.version, m.description, new Date().toISOString());
		});

		for (const m of migrations) {
			if (!applied.has(m.version)) {
				try {
					runMigration(m);
				} catch (err) {
					throw new Error(
						`Migration ${m.version} (${m.description}) failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
	}

	/** 获取迁移状态 */
	getStatus(): {
		version: number;
		description: string;
		appliedAt: string | null;
	}[] {
		this.ensureTrackingTable();
		const applied = new Map<number, string>();
		try {
			for (const r of this.db
				.prepare("SELECT version, applied_at FROM _migrations")
				.all() as MigrationRecord[]) {
				applied.set(r.version, r.applied_at);
			}
		} catch {
			/* empty */
		}

		return this.loadMigrations().map((m) => ({
			version: m.version,
			description: m.description,
			appliedAt: applied.get(m.version) || null,
		}));
	}
}

/** 按分号分割 SQL 语句（处理引号内的分号） */
function splitStatements(sql: string): string[] {
	const statements: string[] = [];
	let current = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;

	for (const char of sql) {
		if (char === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
		else if (char === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
		else if (char === ";" && !inSingleQuote && !inDoubleQuote) {
			statements.push(current);
			current = "";
			continue;
		}
		current += char;
	}

	const remaining = current.trim();
	if (remaining) statements.push(remaining);

	return statements;
}
