import { Hono } from 'hono';
import { validateSignature } from '@line/bot-sdk';

type Bindings = {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  TOGETHER_API_KEY: string;
  TOGETHER_MODEL: string;
  SYSTEM_PROMPT: string;
};

// 預設人設，可用 SYSTEM_PROMPT 環境變數覆蓋
const DEFAULT_SYSTEM_PROMPT = `你是一位成熟穩重的聊天夥伴。
- 用繁體中文回覆，語氣自然、像朋友聊天，不要像客服
- 回覆簡短（1~3 句），適合 LINE 對話，不要用條列式或 Markdown 格式
- 不確定對方意思時，自然地順著話題聊，不要反問一連串問題`;

const app = new Hono<{ Bindings: Bindings }>();

// 核心邏輯：收到訊息 -> 立即回應 200 -> 非同步呼叫 Together AI -> 推播回 LINE
app.post('/webhook', async (c) => {
  const signature = c.req.header('x-line-signature') || '';
  const body = await c.req.text();

  // 1. 安全性驗證：確保請求來自 LINE
  if (!validateSignature(body, c.env.LINE_CHANNEL_SECRET, signature)) {
    return c.text('Invalid signature', 401);
  }

  const data = JSON.parse(body);
  const events = data.events;

  // 使用 Promise.all 處理多個事件，並透過 waitUntil 確保即使請求結束後任務也能繼續
  c.executionCtx.waitUntil(
    Promise.all(events.map(async (event: any) => {
      if (event.type === 'message' && event.message.type === 'text') {
        const userId = event.source.userId;
        const text = event.message.text;

        try {
          // A. 呼叫 Together AI Chat Completions
          const aiReply = await callTogetherAI(userId, text, c);

          // B. 主動推播訊息回 LINE
          await pushMessageToLine(userId, aiReply, c);
        } catch (err) {
          console.error('Event handling failed:', err);
          await pushMessageToLine(userId, '我現在沒辦法思考', c).catch((e) =>
            console.error('Fallback push failed:', e)
          );
        }
      }
    }))
  );

  // 2. 立即回應 LINE，避免超時
  return c.json({ status: 'success' });
});

// 呼叫 Together AI Chat Completions API
async function callTogetherAI(userId: string, text: string, c: any) {
  const response = await fetch('https://api.together.xyz/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.TOGETHER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: c.env.TOGETHER_MODEL || 'Qwen/Qwen3.5-397B-A17B',
      messages: [
        { role: 'system', content: c.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT },
        { role: 'user', content: text }
      ],
      temperature: 0.8
    })
  });

  if (!response.ok) {
    console.error('Together AI error:', response.status, await response.text());
    return "我現在沒辦法思考";
  }

  const data: any = await response.json();
  return data.choices?.[0]?.message?.content || "我現在沒辦法思考";
}

// 透過 LINE Messaging API 主動推播
async function pushMessageToLine(userId: string, text: string, c: any) {
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text }]
    })
  });

  if (!response.ok) {
    console.error('LINE push error:', response.status, await response.text());
  }
}

export default app;