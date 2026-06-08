import { Hono } from 'hono';
import { validateSignature, type webhook } from '@line/bot-sdk';

type Bindings = {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  RUNPOD_ENDPOINT_ID: string;
  RUNPOD_API_KEY: string;
  RUNPOD_CALLBACK_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

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
          // 提交非同步任務給 RunPod，並附上回呼網址，讓 RunPod 處理完後主動通知我們
          await submitRunPodJob(userId, text, origin, c.env);
        } catch (err) {
          console.error('Failed to submit RunPod job', err);
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
async function submitRunPodJob(userId: string, text: string, origin: string, env: Bindings): Promise<void> {
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
        messages: [{ role: 'user', content: text }]
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