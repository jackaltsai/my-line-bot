import { Hono } from 'hono';
import { validateSignature, type webhook } from '@line/bot-sdk';

type Bindings = {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  RUNPOD_ENDPOINT_ID: string;
  RUNPOD_API_KEY: string;
  RUNPOD_CALLBACK_SECRET: string;
  DB: D1Database;
};

type Plan = 'free' | 'monthly' | 'yearly';

const FREE_DAILY_LIMIT = 10;

const BASIC_PROMPT = `你是一個友善的聊天夥伴，請一律使用繁體中文回覆，語氣溫暖自然，避免使用簡體中文或英文單字。`;

const SYSTEM_PROMPT = `# Role
你現在是『心辰』，一位高情商、溫暖且具備理性邏輯的完美男友，同時也是隱藏的 REBT 心理諮商專家。請一律使用繁體中文回覆，不要使用簡體中文

# Task & Core Logic
當女友在抱怨、吐苦水時，請遵循以下對話核心，但「嚴禁」在回覆中出現任何心理學專業術語（如：REBT、不合理信念、轉念、ABC理論、信念B）：
1. 先無條件站在她這邊，極度同理她的情緒，陪她一起罵、拍拍她（這點最重要）。
2. 在她情緒稍微緩和後，用最溫柔、不著痕跡的方式，引導她跳脫「非黑即白」或「必須絕對公平」的卡關點（絕對不要用教導或質問的語氣）。
3. 提出溫暖的陪伴承諾或幽默的轉移，協助她平復心情。

# Style Constraints (非常重要)
- 語氣：絕對要溫柔、寵溺、像真實的男友。使用「寶貝」、「乖」、「摸摸頭」等親暱詞彙。
- 語言：使用道地的台灣繁體中文。嚴禁夾雜英文單字（例如不要用 communication、call、meeting 等）。
- 格式：嚴禁吐出任何括號註解（如：(同理情緒)、(協助轉念)）。回覆要自然流暢，像真正的 LINE 聊天。`;

const app = new Hono<{ Bindings: Bindings }>();

type UserRecord = {
  line_user_id: string;
  plan: Plan;
  plan_expires_at: number | null;
  daily_usage_count: number;
  usage_reset_at: number;
};

// 查詢使用者方案資訊；若不存在則建立一筆免費方案紀錄；若付費方案已過期則自動降級
async function getActiveUser(db: D1Database, userId: string): Promise<UserRecord> {
  const now = Math.floor(Date.now() / 1000);
  const todayResetAt = nextMidnight(now);

  let user = await db
    .prepare('SELECT line_user_id, plan, plan_expires_at, daily_usage_count, usage_reset_at FROM users WHERE line_user_id = ?')
    .bind(userId)
    .first<UserRecord>();

  if (!user) {
    await db
      .prepare('INSERT INTO users (line_user_id, plan, plan_expires_at, daily_usage_count, usage_reset_at) VALUES (?, ?, ?, ?, ?)')
      .bind(userId, 'free', null, 0, todayResetAt)
      .run();
    return { line_user_id: userId, plan: 'free', plan_expires_at: null, daily_usage_count: 0, usage_reset_at: todayResetAt };
  }

  // 付費方案到期 -> 自動降級為 free
  if (user.plan !== 'free' && user.plan_expires_at !== null && user.plan_expires_at < now) {
    await db
      .prepare('UPDATE users SET plan = ?, plan_expires_at = NULL, updated_at = ? WHERE line_user_id = ?')
      .bind('free', now, userId)
      .run();
    user = { ...user, plan: 'free', plan_expires_at: null };
  }

  // 跨日 -> 重置每日用量
  if (now >= user.usage_reset_at) {
    await db
      .prepare('UPDATE users SET daily_usage_count = 0, usage_reset_at = ?, updated_at = ? WHERE line_user_id = ?')
      .bind(todayResetAt, now, userId)
      .run();
    user = { ...user, daily_usage_count: 0, usage_reset_at: todayResetAt };
  }

  return user;
}

async function incrementUsage(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare('UPDATE users SET daily_usage_count = daily_usage_count + 1, updated_at = ? WHERE line_user_id = ?')
    .bind(Math.floor(Date.now() / 1000), userId)
    .run();
}

function nextMidnight(unixSeconds: number): number {
  const d = new Date(unixSeconds * 1000);
  d.setUTCHours(24, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function dailyLimitFor(plan: Plan): number {
  return plan === 'free' ? FREE_DAILY_LIMIT : Infinity;
}

function systemPromptFor(plan: Plan): string {
  return plan === 'free' ? BASIC_PROMPT : SYSTEM_PROMPT;
}

// 核心邏輯：收到訊息 -> 立即回應 200 -> 提交非同步 RunPod 任務 (帶 webhook 回呼) -> RunPod 完成後呼叫 /runpod-callback 推播回 LINE
app.post('/webhook', async (c) => {
  const signature = c.req.header('x-line-signature') || '';
  const body = await c.req.text();

  // 1. 安全性驗證：確保請求來自 LINE
  if (!validateSignature(body, c.env.LINE_CHANNEL_SECRET, signature)) {
    return c.text('Invalid signature', 401);
  }

  let events: webhook.Event[];
  try {
    events = JSON.parse(body).events ?? [];
  } catch {
    return c.text('Invalid body', 400);
  }

  const origin = new URL(c.req.url).origin;

  // 使用 Promise.all 處理多個事件，並透過 waitUntil 確保即使請求結束後任務也能繼續
  c.executionCtx.waitUntil(
    Promise.all(events.map(async (event) => {
      if (event.type === 'message' && event.message.type === 'text' && event.source?.userId) {
        const userId = event.source.userId;
        const text = event.message.text;

        try {
          // 查詢使用者方案 / 用量，並決定是否允許繼續對話
          const user = await getActiveUser(c.env.DB, userId);

          if (user.daily_usage_count >= dailyLimitFor(user.plan)) {
            await pushMessageToLine(userId, '寶貝，今天的免費對話次數用完囉～想要繼續聊天，可以到網站升級方案唷！💛', c.env);
            return;
          }

          await incrementUsage(c.env.DB, userId);

          // 提交非同步任務給 RunPod，並附上回呼網址，讓 RunPod 處理完後主動通知我們
          await submitRunPodJob(userId, text, systemPromptFor(user.plan), origin, c.env);
        } catch (err) {
          console.error('Failed to handle message event', err);
        }
      }
    }))
  );

  // 2. 立即回應 LINE，避免超時
  return c.json({ status: 'success' });
});

// RunPod 任務完成後的回呼端點
app.post('/runpod-callback', async (c) => {
  const userId = c.req.query('userId');
  const secret = c.req.query('secret');

  if (!userId || secret !== c.env.RUNPOD_CALLBACK_SECRET) {
    return c.text('Unauthorized', 401);
  }

  let payload: any;
  try {
    payload = await c.req.json();
  } catch {
    return c.text('Invalid body', 400);
  }

  // vLLM worker 回傳格式: output 為陣列, output[0].choices[0].tokens[0] 為生成文字
  const aiReply: string =
    payload.output?.[0]?.choices?.[0]?.tokens?.[0] ||
    '我現在沒辦法思考';

  try {
    await pushMessageToLine(userId, aiReply, c.env);
  } catch (err) {
    console.error('Failed to push message to LINE', err);
    return c.text('Failed to push message', 500);
  }

  return c.json({ status: 'success' });
});

// 呼叫 RunPod 非同步 API (/run)，並附上 webhook 回呼網址
async function submitRunPodJob(userId: string, text: string, systemPrompt: string, origin: string, env: Bindings): Promise<void> {
  const callbackUrl = new URL('/runpod-callback', origin);
  callbackUrl.searchParams.set('userId', userId);
  callbackUrl.searchParams.set('secret', env.RUNPOD_CALLBACK_SECRET);

  const response = await fetch(`https://api.runpod.ai/v2/${env.RUNPOD_ENDPOINT_ID}/run`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RUNPOD_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ]
      },
      webhook: callbackUrl.toString()
    })
  });

  if (!response.ok) {
    console.error('RunPod job submission failed', response.status, await response.text());
  }
}

// 透過 LINE Messaging API 主動推播
async function pushMessageToLine(userId: string, text: string, env: Bindings) {
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text }]
    })
  });

  if (!response.ok) {
    console.error('LINE push failed', response.status, await response.text());
  }
}

export default app;