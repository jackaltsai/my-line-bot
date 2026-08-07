-- 取消訂閱功能所需欄位：
-- oen_subscription_id：訂閱首期扣款成功後記錄的 OEN 定期定額 ID，呼叫 PUT /subscriptions/{id} 取消時要用
-- subscription_cancelled_at：空字串代表訂閱中；已取消則記錄取消時間，本期額度用完後就不會再扣款
ALTER TABLE users ADD COLUMN oen_subscription_id TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN subscription_cancelled_at TEXT NOT NULL DEFAULT '';
