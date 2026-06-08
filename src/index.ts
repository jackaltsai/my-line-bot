import { Hono } from 'hono';
import { validateSignature, type webhook } from '@line/bot-sdk';

type Bindings = {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  RUNPOD_ENDPOINT_ID: string;
  RUNPOD_API_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// 核心邏輯：收到訊息 -> 立即回應 200 -> 非同步呼叫 RunPod -> 推播回 LINE
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

  // 使用 Promise.all 處理多個事件，並透過 waitUntil 確保即使請求結束後任務也能繼續
  c.executionCtx.waitUntil(
    Promise.all(events.map(async (event) => {
      if (event.type === 'message' && event.message.type === 'text' && event.source?.userId) {
        const userId = event.source.userId;
        const text = event.message.text;

        try {
          // A. 呼叫 RunPod Serverless (非同步調用 /run)
          const aiReply = await callRunPod(userId, text, c.env);

          // B. 主動推播訊息回 LINE
          await pushMessageToLine(userId, aiReply, c.env);
        } catch (err) {
          console.error('Failed to handle message event', err);
        }
      }
    }))
  );

  // 2. 立即回應 LINE，避免超時
  return c.json({ status: 'success' });
});

// 呼叫 RunPod API
async function callRunPod(userId: string, text: string, env: Bindings): Promise<string> {
  const response = await fetch(`https://api.runpod.ai/v2/${env.RUNPOD_ENDPOINT_ID}/runsync`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RUNPOD_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ input: { userId, text } })
  });

  if (!response.ok) {
    console.error('RunPod request failed', response.status, await response.text());
    return '我現在沒辦法思考';
  }

  const data: any = await response.json();
  // 根據 RunPod 的輸出結構調整
  return data.output?.message || '我現在沒辦法思考';
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