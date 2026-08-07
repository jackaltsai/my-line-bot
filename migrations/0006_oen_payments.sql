-- 應援科技（OEN）金流串接：購買前發票資訊蒐集 + 交易紀錄表
ALTER TABLE users ADD COLUMN purchase_intake_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN invoice_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN invoice_email TEXT NOT NULL DEFAULT '';

-- transaction_id 是建立 OEN checkout 時拿到的 data.id，在收到 webhook 前就先寫入，
-- 用來把 webhook 對應回是哪個 LINE 使用者；status 從 'pending' 轉成 'charged'/'failed'
-- 是原子操作（UPDATE ... WHERE status = 'pending'），避免 webhook 重送重複核發額度。
CREATE TABLE IF NOT EXISTS oen_transactions (
  transaction_id TEXT PRIMARY KEY,
  order_id TEXT UNIQUE NOT NULL,
  line_user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_oen_transactions_user ON oen_transactions(line_user_id);
