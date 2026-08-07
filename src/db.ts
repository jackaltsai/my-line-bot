import type { PersonaId } from './personas';

export const FREE_DAILY_LIMIT = 10;
export const PREMIUM_CREDITS_GRANT = 500;

export interface UserState {
  line_user_id: string;
  plan: 'free' | 'premium';
  persona: PersonaId;
  message_count_today: number;
  last_message_date: string;
  premium_credits: number;
  join_date: string;
  onboarding_step: number;   // 0=new 1=Q1 sent 2=Q2 sent 3=Q3 sent 4=complete
  onboarding_q1: string;
  onboarding_q2: string;
  nickname: string;
  last_active: string;       // ISO timestamp
  silence_stage: number;     // 0=none 1=24h sent 2=48h sent 3=7d sent
  paywall_triggered: number; // 0|1
  total_turns: number;
  milestones_triggered: string; // JSON array of milestone IDs
  purchase_intake_step: number; // 0=none 1=等待姓名 2=等待email（OEN 開發票用）
  invoice_name: string;
  invoice_email: string;
  oen_subscription_id: string;      // OEN 定期定額 ID，取消訂閱時要用
  subscription_cancelled_at: string; // 空字串=訂閱中；非空=已取消（本期用完後不再扣款）
  /** 暫態欄位（不存在 DB）：此次 getOrCreateUser 是否為首次建立 */
  is_new?: boolean;
}

function today(): string {
  // 以台灣時區（UTC+8）計算日期，讓免費額度在台灣午夜重置
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 取得使用者狀態，若不存在則建立預設（免費方案）資料
export async function getOrCreateUser(db: D1Database, lineUserId: string): Promise<UserState> {
  const existing = await db
    .prepare('SELECT * FROM users WHERE line_user_id = ?')
    .bind(lineUserId)
    .first<UserState>();

  const date = today();
  const now = new Date().toISOString();

  if (!existing) {
    await db
      .prepare(
        `INSERT INTO users
           (line_user_id, plan, persona, message_count_today, last_message_date,
            premium_credits, join_date, onboarding_step, onboarding_q1,
            onboarding_q2, nickname, last_active, silence_stage, paywall_triggered)
         VALUES (?, 'free', 'chen', 0, ?, 0, ?, 0, '', '', '', ?, 0, 0)`
      )
      .bind(lineUserId, date, date, now)
      .run();

    return {
      line_user_id: lineUserId,
      plan: 'free',
      persona: 'chen',
      message_count_today: 0,
      last_message_date: date,
      premium_credits: 0,
      join_date: date,
      onboarding_step: 0,
      onboarding_q1: '',
      onboarding_q2: '',
      nickname: '',
      last_active: now,
      silence_stage: 0,
      paywall_triggered: 0,
      total_turns: 0,
      milestones_triggered: '[]',
      purchase_intake_step: 0,
      invoice_name: '',
      invoice_email: '',
      oen_subscription_id: '',
      subscription_cancelled_at: '',
      is_new: true
    };
  }

  // 跨日重置免費方案的每日對話次數
  if (existing.last_message_date !== date) {
    await db
      .prepare(`UPDATE users SET message_count_today = 0, last_message_date = ?,
                updated_at = datetime('now') WHERE line_user_id = ?`)
      .bind(date, lineUserId)
      .run();
    existing.message_count_today = 0;
    existing.last_message_date = date;
  }

  // 舊紀錄若 join_date 為空，補設為今日（migration 後首次對話時修正）
  if (!existing.join_date) {
    await db
      .prepare(`UPDATE users SET join_date = ? WHERE line_user_id = ?`)
      .bind(date, lineUserId)
      .run();
    existing.join_date = date;
  }

  return existing;
}

// 檢查使用者是否還有對話額度
export function hasQuota(user: UserState): boolean {
  if (user.plan === 'premium') {
    return user.premium_credits > 0;
  }
  return user.message_count_today < FREE_DAILY_LIMIT;
}

// 扣除一次對話額度（免費：累加當日次數；付費：扣除剩餘額度）
export async function consumeQuota(db: D1Database, user: UserState): Promise<void> {
  if (user.plan === 'premium') {
    await db
      .prepare(`UPDATE users SET premium_credits = premium_credits - 1,
                updated_at = datetime('now') WHERE line_user_id = ?`)
      .bind(user.line_user_id)
      .run();
    user.premium_credits -= 1;
  } else {
    await db
      .prepare(`UPDATE users SET message_count_today = message_count_today + 1,
                updated_at = datetime('now') WHERE line_user_id = ?`)
      .bind(user.line_user_id)
      .run();
    user.message_count_today += 1;
  }
}

// 切換人設（僅付費方案可呼叫）
export async function setPersona(db: D1Database, lineUserId: string, persona: PersonaId): Promise<void> {
  await db
    .prepare(`UPDATE users SET persona = ?, updated_at = datetime('now') WHERE line_user_id = ?`)
    .bind(persona, lineUserId)
    .run();
}

// 升級為付費方案並核發對話額度（訂閱首期扣款成功時呼叫）
export async function upgradeToPremium(db: D1Database, lineUserId: string, credits = PREMIUM_CREDITS_GRANT): Promise<void> {
  await db
    .prepare(`UPDATE users SET plan = 'premium', premium_credits = premium_credits + ?,
              updated_at = datetime('now') WHERE line_user_id = ?`)
    .bind(credits, lineUserId)
    .run();
}

// 訂閱每期扣款成功時呼叫：把額度重置為當期核發量（而非累加），對應「每月 500 則」的訂閱額度
export async function resetPremiumCredits(db: D1Database, lineUserId: string, credits = PREMIUM_CREDITS_GRANT): Promise<void> {
  await db
    .prepare(`UPDATE users SET plan = 'premium', premium_credits = ?,
              updated_at = datetime('now') WHERE line_user_id = ?`)
    .bind(credits, lineUserId)
    .run();
}

// 降回免費方案：歸零付費額度並清除長期記憶（測試用）
export async function downgradeToFree(db: D1Database, lineUserId: string): Promise<void> {
  await db
    .prepare(`UPDATE users SET plan = 'free', premium_credits = 0, persona = 'chen',
              updated_at = datetime('now') WHERE line_user_id = ?`)
    .bind(lineUserId)
    .run();
  await db
    .prepare('DELETE FROM messages WHERE line_user_id = ?')
    .bind(lineUserId)
    .run();
}

// 取得最近對話紀錄（付費方案的長期記憶），由舊到新排序
export async function getRecentMessages(db: D1Database, lineUserId: string, limit = 20) {
  const { results } = await db
    .prepare(
      `SELECT role, content FROM messages
       WHERE line_user_id = ?
       ORDER BY id DESC
       LIMIT ?`
    )
    .bind(lineUserId, limit)
    .all<{ role: 'user' | 'assistant'; content: string }>();

  return (results || []).reverse();
}

// 儲存一則對話訊息（僅付費方案使用，作為長期記憶）
export async function saveMessage(db: D1Database, lineUserId: string, role: 'user' | 'assistant', content: string): Promise<void> {
  await db
    .prepare('INSERT INTO messages (line_user_id, role, content) VALUES (?, ?, ?)')
    .bind(lineUserId, role, content)
    .run();
}

// 取得所有付費方案使用者（每日主動問候用）
export async function getPremiumUsers(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT line_user_id FROM users WHERE plan = 'premium'`)
    .all<{ line_user_id: string }>();

  return (results || []).map((r) => r.line_user_id);
}

// 更新 onboarding 進度步驟
export async function updateOnboardingStep(db: D1Database, lineUserId: string, step: number): Promise<void> {
  await db
    .prepare(`UPDATE users SET onboarding_step = ?, updated_at = datetime('now') WHERE line_user_id = ?`)
    .bind(step, lineUserId)
    .run();
}

// 儲存 onboarding Q1/Q2 答案
export async function saveOnboardingAnswer(
  db: D1Database,
  lineUserId: string,
  field: 'onboarding_q1' | 'onboarding_q2' | 'nickname',
  value: string
): Promise<void> {
  await db
    .prepare(`UPDATE users SET ${field} = ?, updated_at = datetime('now') WHERE line_user_id = ?`)
    .bind(value, lineUserId)
    .run();
}

// 更新最後活躍時間並重置沉默階段
export async function updateLastActive(db: D1Database, lineUserId: string): Promise<void> {
  await db
    .prepare(`UPDATE users SET last_active = datetime('now'), silence_stage = 0,
              updated_at = datetime('now') WHERE line_user_id = ?`)
    .bind(lineUserId)
    .run();
}

// 取得需要沉默召回的用戶（onboarding 完成且 silence_stage < 3）
export async function getUsersForSilenceCheck(db: D1Database): Promise<
  { line_user_id: string; silence_stage: number; last_active: string }[]
> {
  const { results } = await db
    .prepare(
      `SELECT line_user_id, silence_stage, last_active FROM users
       WHERE onboarding_step >= 4 AND silence_stage < 3 AND last_active != ''`
    )
    .all<{ line_user_id: string; silence_stage: number; last_active: string }>();
  return results || [];
}

// 更新沉默階段
export async function updateSilenceStage(db: D1Database, lineUserId: string, stage: number): Promise<void> {
  await db
    .prepare(`UPDATE users SET silence_stage = ? WHERE line_user_id = ?`)
    .bind(stage, lineUserId)
    .run();
}

// 標記付費牆已觸發（不重複顯示）
export async function markPaywallTriggered(db: D1Database, lineUserId: string): Promise<void> {
  await db
    .prepare(`UPDATE users SET paywall_triggered = 1, updated_at = datetime('now') WHERE line_user_id = ?`)
    .bind(lineUserId)
    .run();
}

// 遞增對話總輪次，回傳新的 total_turns
export async function incrementTotalTurns(db: D1Database, lineUserId: string): Promise<number> {
  await db
    .prepare(`UPDATE users SET total_turns = total_turns + 1, updated_at = datetime('now') WHERE line_user_id = ?`)
    .bind(lineUserId)
    .run();
  const row = await db
    .prepare('SELECT total_turns FROM users WHERE line_user_id = ?')
    .bind(lineUserId)
    .first<{ total_turns: number }>();
  return row?.total_turns ?? 1;
}

// 標記里程碑已觸發（milestones_triggered 是 JSON 陣列字串）
export async function addMilestoneTrigger(db: D1Database, lineUserId: string, milestone: string): Promise<void> {
  const row = await db
    .prepare('SELECT milestones_triggered FROM users WHERE line_user_id = ?')
    .bind(lineUserId)
    .first<{ milestones_triggered: string }>();
  const current: string[] = JSON.parse(row?.milestones_triggered || '[]');
  if (current.includes(milestone)) return;
  current.push(milestone);
  await db
    .prepare(`UPDATE users SET milestones_triggered = ?, updated_at = datetime('now') WHERE line_user_id = ?`)
    .bind(JSON.stringify(current), lineUserId)
    .run();
}

// 取得昨日是否有對話（用於個人化早安推播）
export async function hadConversationYesterday(db: D1Database, lineUserId: string): Promise<boolean> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const row = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM messages
       WHERE line_user_id = ? AND role = 'user' AND created_at >= ? AND created_at < ?`
    )
    .bind(lineUserId, `${yesterday} 00:00:00`, `${yesterday} 23:59:59`)
    .first<{ cnt: number }>();
  return (row?.cnt ?? 0) > 0;
}

// 記錄一次 AI 回應的 token 用量
export async function logUsage(
  db: D1Database,
  lineUserId: string,
  plan: string,
  model: string,
  promptTokens: number,
  completionTokens: number
): Promise<void> {
  await db
    .prepare('INSERT INTO usage_log (line_user_id, plan, model, prompt_tokens, completion_tokens) VALUES (?, ?, ?, ?, ?)')
    .bind(lineUserId, plan, model, promptTokens, completionTokens)
    .run();
}

// 更新購買前發票資訊蒐集的步驟（0=none 1=等待姓名 2=等待email）
export async function updatePurchaseIntakeStep(db: D1Database, lineUserId: string, step: number): Promise<void> {
  await db
    .prepare(`UPDATE users SET purchase_intake_step = ?, updated_at = datetime('now') WHERE line_user_id = ?`)
    .bind(step, lineUserId)
    .run();
}

// 儲存發票用的姓名/email
export async function saveInvoiceInfo(
  db: D1Database,
  lineUserId: string,
  field: 'invoice_name' | 'invoice_email',
  value: string
): Promise<void> {
  await db
    .prepare(`UPDATE users SET ${field} = ?, updated_at = datetime('now') WHERE line_user_id = ?`)
    .bind(value, lineUserId)
    .run();
}

// 建立 OEN 訂閱首期交易的待處理紀錄；在轉址付款頁前先寫入，讓 webhook 進來時能對應回是哪個 LINE 使用者
export async function createPendingOenTransaction(
  db: D1Database,
  params: { transactionId: string; orderId: string; lineUserId: string; amount: number }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO oen_transactions (transaction_id, order_id, line_user_id, amount, status)
       VALUES (?, ?, ?, ?, 'pending')`
    )
    .bind(params.transactionId, params.orderId, params.lineUserId, params.amount)
    .run();
}

// 依 order_id 回查建立訂閱時登記的 line_user_id；訂閱後續每期扣款會有全新的 transaction_id，
// 但共用建立訂閱當下的 order_id，藉此在拿不到 customId 時仍能對應回使用者
export async function getOenLineUserIdByOrderId(db: D1Database, orderId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT line_user_id FROM oen_transactions WHERE order_id = ? LIMIT 1')
    .bind(orderId)
    .first<{ line_user_id: string }>();
  return row?.line_user_id ?? null;
}

// 原子登記一筆訂閱續期扣款結果；transaction_id 是 PRIMARY KEY，INSERT OR IGNORE 讓
// webhook 重送時不會重複核發額度。回傳是否為本次呼叫真正寫入（true 才需要核發/通知）
export async function recordOenRenewalCharge(
  db: D1Database,
  params: { transactionId: string; orderId: string; lineUserId: string; amount: number; status: 'charged' | 'failed' }
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO oen_transactions (transaction_id, order_id, line_user_id, amount, status)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(params.transactionId, params.orderId, params.lineUserId, params.amount, params.status)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// 訂閱首期扣款確認成功時呼叫：記錄 OEN 定期定額 ID（取消訂閱時要用），
// 並清空取消時間戳記（若使用者取消後重新訂閱，等同開了一筆全新的訂閱）
export async function saveOenSubscriptionId(db: D1Database, lineUserId: string, subscriptionId: string): Promise<void> {
  await db
    .prepare(`UPDATE users SET oen_subscription_id = ?, subscription_cancelled_at = '',
              updated_at = datetime('now') WHERE line_user_id = ?`)
    .bind(subscriptionId, lineUserId)
    .run();
}

// 標記訂閱已取消（本期額度用完後就不會再扣款）；用量不變，僅記錄取消時間
export async function markSubscriptionCancelled(db: D1Database, lineUserId: string): Promise<void> {
  await db
    .prepare(`UPDATE users SET subscription_cancelled_at = datetime('now'),
              updated_at = datetime('now') WHERE line_user_id = ?`)
    .bind(lineUserId)
    .run();
}

export interface OenTransactionRow {
  transaction_id: string;
  order_id: string;
  line_user_id: string;
  amount: number;
  status: 'pending' | 'charged' | 'failed';
}

export async function getOenTransaction(db: D1Database, transactionId: string): Promise<OenTransactionRow | null> {
  const row = await db
    .prepare('SELECT * FROM oen_transactions WHERE transaction_id = ?')
    .bind(transactionId)
    .first<OenTransactionRow>();
  return row ?? null;
}

// 把交易從 pending 轉成終態；WHERE status = 'pending' 確保這是原子操作，
// 回傳是否為本次呼叫真正完成轉換（避免 webhook 重送時重複核發額度）
export async function finalizeOenTransaction(
  db: D1Database,
  transactionId: string,
  status: 'charged' | 'failed'
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE oen_transactions SET status = ?, updated_at = datetime('now')
       WHERE transaction_id = ? AND status = 'pending'`
    )
    .bind(status, transactionId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export interface UsageSummaryRow {
  model: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
}

// 用量彙總（成本報表）：依模型分組，可限定起始日（YYYY-MM-DD，UTC）
export async function getUsageSummary(db: D1Database, sinceDate?: string): Promise<UsageSummaryRow[]> {
  const where = sinceDate ? "WHERE created_at >= ?" : '';
  const stmt = db.prepare(
    `SELECT model,
            COUNT(*) AS requests,
            SUM(prompt_tokens) AS prompt_tokens,
            SUM(completion_tokens) AS completion_tokens
     FROM usage_log ${where}
     GROUP BY model
     ORDER BY requests DESC`
  );
  const { results } = await (sinceDate ? stmt.bind(sinceDate) : stmt).all<UsageSummaryRow>();
  return results || [];
}
