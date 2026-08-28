-- 计费系统：订单与许可证（SQLite 方言，本地模式与云端模式共存）
CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  plan_id        TEXT NOT NULL,
  period         TEXT NOT NULL DEFAULT 'monthly',
  amount         INTEGER NOT NULL,
  currency       TEXT DEFAULT 'CNY',
  status         TEXT NOT NULL DEFAULT 'pending',
  payment_method TEXT DEFAULT 'simulated',
  qr_code_url    TEXT DEFAULT '',
  created_at     TEXT NOT NULL,
  paid_at        TEXT,
  expires_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

CREATE TABLE IF NOT EXISTS licenses (
  id         TEXT PRIMARY KEY,
  key_hash   TEXT NOT NULL UNIQUE,
  user_id    TEXT NOT NULL REFERENCES users(id),
  plan_id    TEXT NOT NULL,
  period     TEXT NOT NULL DEFAULT 'monthly',
  order_id   TEXT REFERENCES orders(id),
  is_active  INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  metadata   TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_licenses_user ON licenses(user_id);
CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(key_hash);
CREATE INDEX IF NOT EXISTS idx_licenses_active ON licenses(is_active);
