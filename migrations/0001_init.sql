-- 使用者方案、額度與人設狀態
CREATE TABLE IF NOT EXISTS users (
  line_user_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free',           -- 'free' | 'premium'
  persona TEXT NOT NULL DEFAULT 'chen',        -- chen/yan/ye/yu
  message_count_today INTEGER NOT NULL DEFAULT 0,
  last_message_date TEXT NOT NULL DEFAULT '',  -- YYYY-MM-DD (UTC)
  premium_credits INTEGER NOT NULL DEFAULT 0,  -- 付費方案剩餘對話額度
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 長期對話記憶（僅付費方案使用）
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT NOT NULL,
  role TEXT NOT NULL,    -- 'user' | 'assistant'
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_user_created
  ON messages (line_user_id, created_at);
