-- LINE Pay 訂單紀錄
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  line_user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'paid' | 'cancelled'
  transaction_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (line_user_id);
