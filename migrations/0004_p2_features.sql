-- P2/P3 功能：關係里程碑與幽默招牌所需欄位
ALTER TABLE users ADD COLUMN total_turns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN milestones_triggered TEXT NOT NULL DEFAULT '[]';
