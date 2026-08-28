-- ===== 001_init: 初始建表 =====

-- 会话
CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT,
    workspace_id  TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    TEXT NOT NULL,
    completed_at  TEXT,
    user_input    TEXT NOT NULL,
    config_json   TEXT,
    turn_count    INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    error_count   INTEGER DEFAULT 0,
    stop_reason   TEXT,
    duration_ms   INTEGER,
    final_answer  TEXT,
    context_usage INTEGER,
    token_usage   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

-- 消息
CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn        INTEGER NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT,
    tool_call_id TEXT,
    name        TEXT,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, turn);

-- 工具调用
CREATE TABLE IF NOT EXISTS tool_calls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn        INTEGER NOT NULL,
    tool_type   TEXT NOT NULL,
    args_json   TEXT NOT NULL,
    success     INTEGER NOT NULL,
    result_data TEXT,
    result_error TEXT,
    duration_ms INTEGER,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_toolcalls_session ON tool_calls(session_id, turn);
CREATE INDEX IF NOT EXISTS idx_toolcalls_type ON tool_calls(tool_type);

-- 错误记录
CREATE TABLE IF NOT EXISTS errors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn        INTEGER NOT NULL,
    site        TEXT NOT NULL,
    message     TEXT NOT NULL,
    recoverable INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_errors_session ON errors(session_id);

-- 压缩记录
CREATE TABLE IF NOT EXISTS compactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn          INTEGER NOT NULL,
    level         INTEGER NOT NULL,
    before_count  INTEGER NOT NULL,
    after_count   INTEGER NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compactions_session ON compactions(session_id, turn);

-- 用户
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'free',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    last_login_at TEXT
);

-- 用量跟踪
CREATE TABLE IF NOT EXISTS usage_records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(id),
    date        TEXT NOT NULL,
    task_count  INTEGER DEFAULT 0,
    turn_count  INTEGER DEFAULT 0,
    token_count INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    UNIQUE(user_id, date)
);

-- Daemon 任务
CREATE TABLE IF NOT EXISTS daemon_tasks (
    id                TEXT PRIMARY KEY,
    user_id           TEXT REFERENCES users(id),
    user_input        TEXT NOT NULL,
    config_json       TEXT,
    status            TEXT NOT NULL DEFAULT 'queued',
    created_at        TEXT NOT NULL,
    started_at        TEXT,
    completed_at      TEXT,
    current_turn      INTEGER DEFAULT 0,
    current_tool_call TEXT,
    progress_summary  TEXT,
    result_json       TEXT,
    error             TEXT
);

CREATE INDEX IF NOT EXISTS idx_daemontasks_status ON daemon_tasks(status);
CREATE INDEX IF NOT EXISTS idx_daemontasks_user ON daemon_tasks(user_id);
