import type { PersonaId } from './personas';

export const FREE_DAILY_LIMIT = 10;
export const PREMIUM_CREDITS_GRANT = 1500;

export interface UserState {
  line_user_id: string;
  plan: 'free' | 'premium';
  persona: PersonaId;
  message_count_today: number;
  last_message_date: string;
  premium_credits: number;
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

  if (!existing) {
    await db
      .prepare(
        `INSERT INTO users (line_user_id, plan, persona, message_count_today, last_message_date, premium_credits)
         VALUES (?, 'free', 'chen', 0, ?, 0)`
      )
      .bind(lineUserId, date)
      .run();

    return {
      line_user_id: lineUserId,
      plan: 'free',
      persona: 'chen',
      message_count_today: 0,
      last_message_date: date,
      premium_credits: 0
    };
  }

  // 跨日重置免費方案的每日對話次數
  if (existing.last_message_date !== date) {
    await db
      .prepare('UPDATE users SET message_count_today = 0, last_message_date = ?, updated_at = datetime(\'now\') WHERE line_user_id = ?')
      .bind(date, lineUserId)
      .run();
    existing.message_count_today = 0;
    existing.last_message_date = date;
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
      .prepare('UPDATE users SET premium_credits = premium_credits - 1, updated_at = datetime(\'now\') WHERE line_user_id = ?')
      .bind(user.line_user_id)
      .run();
    user.premium_credits -= 1;
  } else {
    await db
      .prepare('UPDATE users SET message_count_today = message_count_today + 1, updated_at = datetime(\'now\') WHERE line_user_id = ?')
      .bind(user.line_user_id)
      .run();
    user.message_count_today += 1;
  }
}

// 切換人設（僅付費方案可呼叫）
export async function setPersona(db: D1Database, lineUserId: string, persona: PersonaId): Promise<void> {
  await db
    .prepare('UPDATE users SET persona = ?, updated_at = datetime(\'now\') WHERE line_user_id = ?')
    .bind(persona, lineUserId)
    .run();
}

// 升級為付費方案並核發對話額度
export async function upgradeToPremium(db: D1Database, lineUserId: string, credits = PREMIUM_CREDITS_GRANT): Promise<void> {
  await db
    .prepare('UPDATE users SET plan = \'premium\', premium_credits = premium_credits + ?, updated_at = datetime(\'now\') WHERE line_user_id = ?')
    .bind(credits, lineUserId)
    .run();
}

// 降回免費方案：歸零付費額度並清除長期記憶（測試用）
export async function downgradeToFree(db: D1Database, lineUserId: string): Promise<void> {
  await db
    .prepare('UPDATE users SET plan = \'free\', premium_credits = 0, persona = \'chen\', updated_at = datetime(\'now\') WHERE line_user_id = ?')
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
    .prepare('SELECT line_user_id FROM users WHERE plan = \'premium\'')
    .all<{ line_user_id: string }>();

  return (results || []).map((r) => r.line_user_id);
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
