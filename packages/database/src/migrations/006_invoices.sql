-- 计费系统：发票（SQLite 方言，本地模式与云端模式共存）
CREATE TABLE IF NOT EXISTS invoices (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  plan_id    TEXT NOT NULL,
  period     TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  currency   TEXT DEFAULT 'CNY',
  status     TEXT NOT NULL DEFAULT 'pending',
  items      TEXT DEFAULT '[]',
  notes      TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  paid_at    TEXT,
  due_date   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_period ON invoices(period);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due ON invoices(due_date);
