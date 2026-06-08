-- 若網站已建立 users 表，請先確認欄位名稱是否一致；如不一致請依實際情況調整本檔或 src/index.ts 的查詢語句。
CREATE TABLE IF NOT EXISTS users (
  line_user_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free',       -- 'free' | 'monthly' | 'yearly'
  plan_expires_at INTEGER,                 -- unix timestamp，付費方案到期時間（free 為 NULL）
  daily_usage_count INTEGER NOT NULL DEFAULT 0,
  usage_reset_at INTEGER NOT NULL,         -- 下次重置每日用量的 unix timestamp
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
