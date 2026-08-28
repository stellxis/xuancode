-- ===== 002_add_task_concurrency: 为 daemon_tasks 添加并发与审查相关列 =====

ALTER TABLE daemon_tasks ADD COLUMN permission_level TEXT DEFAULT 'free';
ALTER TABLE daemon_tasks ADD COLUMN review_result_json TEXT;
ALTER TABLE daemon_tasks ADD COLUMN awaiting_since INTEGER;
ALTER TABLE daemon_tasks ADD COLUMN pending_question TEXT;
ALTER TABLE daemon_tasks ADD COLUMN intervention_count INTEGER DEFAULT 0;
