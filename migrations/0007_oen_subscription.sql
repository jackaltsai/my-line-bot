-- 改為純訂閱制金流：同一筆訂閱的每期扣款會共用建立訂閱當下的 order_id
-- （用來在收到續期扣款 webhook、但沒有現成 transaction_id 對應紀錄時，回查是哪個使用者）。
-- 舊表對 order_id 有 UNIQUE 限制（一次性購買時代每筆訂單只會有一筆交易），SQLite 不支援
-- 直接 DROP CONSTRAINT，改用重建表的方式移除；扣款去重改完全依賴 transaction_id（PRIMARY KEY）。
CREATE TABLE oen_transactions_new (
  transaction_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  line_user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO oen_transactions_new
  SELECT transaction_id, order_id, line_user_id, amount, status, created_at, updated_at
  FROM oen_transactions;

DROP TABLE oen_transactions;
ALTER TABLE oen_transactions_new RENAME TO oen_transactions;

CREATE INDEX IF NOT EXISTS idx_oen_transactions_user ON oen_transactions(line_user_id);
CREATE INDEX IF NOT EXISTS idx_oen_transactions_order ON oen_transactions(order_id);
