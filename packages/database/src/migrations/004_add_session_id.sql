-- ===== 004_add_session_id: 为 daemon_tasks 添加 session_id 关联列 =====
-- 与内嵌迁移 EMBEDDED_MIGRATIONS version 4 保持一致

ALTER TABLE daemon_tasks ADD COLUMN session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_daemontasks_session ON daemon_tasks(session_id);
