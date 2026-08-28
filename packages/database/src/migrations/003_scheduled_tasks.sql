-- ============================================================
-- 003_scheduled_tasks: 定时任务模板表
-- 支持 cron 表达式调度、失败重试、执行历史关联
-- ============================================================

CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id                TEXT PRIMARY KEY,
    user_id           TEXT,
    name              TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    cron_expression   TEXT NOT NULL,
    user_input        TEXT NOT NULL,
    config_json       TEXT,
    enabled           INTEGER NOT NULL DEFAULT 1,
    max_retries       INTEGER NOT NULL DEFAULT 3,
    retry_interval_ms INTEGER NOT NULL DEFAULT 60000,
    next_retry_at     TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    last_run_at       TEXT,
    next_run_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_schedtasks_nextrun ON scheduled_tasks(next_run_at);
CREATE INDEX IF NOT EXISTS idx_schedtasks_enabled ON scheduled_tasks(enabled);

ALTER TABLE daemon_tasks ADD COLUMN scheduled_task_id TEXT;
ALTER TABLE daemon_tasks ADD COLUMN retry_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_daemontasks_scheduled ON daemon_tasks(scheduled_task_id);
