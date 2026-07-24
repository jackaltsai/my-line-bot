-- Stripe 金流串接：webhook 事件去重表，避免 Stripe 重送事件時重複派發付費額度
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
