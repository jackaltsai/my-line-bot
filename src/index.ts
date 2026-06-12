import { Hono } from 'hono';
import { validateSignature } from '@line/bot-sdk';
import {
  FREE_DAILY_LIMIT,
  consumeQuota,
  getOrCreateUser,
  getPremiumUsers,
  getRecentMessages,
  hasQuota,
  saveMessage,
  setPersona,
  upgradeToPremium,
  type UserState
} from './db';
import { FREE_SYSTEM_PROMPT, PERSONAS, getPersona, type PersonaId } from './personas';

type Bindings = {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  TOGETHER_API_KEY: string;
  TOGETHER_MODEL: string;
  ADMIN_SECRET: string;
  DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

const PERSONA_NAME_TO_ID: Record<string, PersonaId> = {
  '沉': 'chen',
  '言': 'yan',
  '夜': 'ye',
  '嶼': 'yu'
};

// 核心邏輯：收到訊息 -> 立即回應 200 -> 非同步處理（額度檢查/指令/AI 回覆）-> 推播回 LINE
app.post('/webhook', async (c) => {
  const signature = c.req.header('x-line-signature') || '';
  const body = await c.req.text();

  // 1. 安全性驗證：確保請求來自 LINE
  if (!validateSignature(body, c.env.LINE_CHANNEL_SECRET, signature)) {
    return c.text('Invalid signature', 401);
  }

  const data = JSON.parse(body);
  const events = data.events;

  c.executionCtx.waitUntil(
    Promise.all(events.map(async (event: any) => {
      if (event.type === 'message' && event.message.type === 'text') {
        const userId = event.source.userId;
        const text = event.message.text.trim();

        try {
          const reply = await handleMessage(c, userId, text);
          await pushMessageToLine(userId, reply, c);
        } catch (err) {
          console.error('Event handling failed:', err);
          await pushMessageToLine(userId, '我現在沒辦法思考', c).catch((e) =>
            console.error('Fallback push failed:', e)
          );
        }
      } else if (event.type === 'message' && event.message.type === 'sticker') {
        const userId = event.source.userId;

        try {
          const reply = await handleSticker(c, userId, event.message.packageId, event.message.stickerId);
          await pushMessageToLine(userId, reply, c);
        } catch (err) {
          console.error('Sticker handling failed:', err);
        }
      }
    }))
  );

  // 2. 立即回應 LINE，避免超時
  return c.json({ status: 'success' });
});

async function handleMessage(c: any, userId: string, text: string): Promise<string> {
  const db = c.env.DB as D1Database;
  const user = await getOrCreateUser(db, userId);

  // 指令處理
  const command = await handleCommand(c, user, text);
  if (command !== null) {
    return command;
  }

  // 額度檢查
  if (!hasQuota(user)) {
    return user.plan === 'premium'
      ? '你的對話額度已經用完囉，感謝你一直以來的陪伴 🥹 期待未來能再續約繼續聊天～'
      : `今天的免費額度（${FREE_DAILY_LIMIT} 則）已經用完了，明天再來找我聊天吧！想要更多對話次數、長期記憶與更多人設，可以輸入「升級」了解付費方案 💛`;
  }

  // 呼叫 AI 並回覆
  const reply = await callTogetherAI(user, text, c);

  await consumeQuota(db, user);
  if (user.plan === 'premium') {
    await saveMessage(db, userId, 'user', text);
    await saveMessage(db, userId, 'assistant', reply);
  }

  return reply;
}

// 處理特殊指令（狀態查詢、人設切換、升級資訊、管理員手動升級）
// 回傳 null 代表非指令，應走一般 AI 對話流程
async function handleCommand(c: any, user: UserState, text: string): Promise<string | null> {
  const db = c.env.DB as D1Database;

  if (text === '狀態' || text === '我的方案') {
    const persona = getPersona(user.persona);
    if (user.plan === 'premium') {
      return `【付費方案】\n人設：${persona.label}\n剩餘對話額度：${user.premium_credits} 則（無使用期限）\n輸入「人設」可查看可切換的人設`;
    }
    return `【免費方案】\n人設：${persona.label}\n今日剩餘對話次數：${Math.max(0, FREE_DAILY_LIMIT - user.message_count_today)} / ${FREE_DAILY_LIMIT}\n輸入「升級」了解付費方案`;
  }

  if (text === '人設' || text === '切換人設') {
    if (user.plan !== 'premium') {
      return `免費方案僅提供「${getPersona('chen').label}」一種人設。\n升級付費方案即可在「沉、言、夜、嶼」四種人設間任意切換 💛 輸入「升級」了解詳情`;
    }
    const list = Object.values(PERSONAS).map((p) => `${p.label}`).join('\n');
    return `輸入人設名稱（沉／言／夜／嶼）即可切換：\n${list}\n目前使用：${getPersona(user.persona).label}`;
  }

  if (text in PERSONA_NAME_TO_ID) {
    const personaId = PERSONA_NAME_TO_ID[text];
    if (user.plan !== 'premium') {
      return `免費方案僅提供「${getPersona('chen').label}」一種人設，升級付費方案即可任意切換四種人設喔 💛`;
    }
    await setPersona(db, user.line_user_id, personaId);
    return `已切換為「${getPersona(personaId).label}」，從現在開始用這個樣子陪你聊天 😊`;
  }

  if (text === '升級' || text === '付費' || text === '付費方案') {
    return [
      '【付費方案】',
      '・1500 則對話額度，無使用期限',
      '・深度情緒感知與長期記憶',
      '・四種人設（沉、言、夜、嶼）任意切換',
      '・每日主動問候',
      '',
      '付款功能即將上線，敬請期待！'
    ].join('\n');
  }

  // 管理員手動升級（金流上線前的暫時方案）：「/admin upgrade <ADMIN_SECRET>」
  if (text.startsWith('/admin upgrade ')) {
    const secret = text.slice('/admin upgrade '.length).trim();
    if (c.env.ADMIN_SECRET && secret === c.env.ADMIN_SECRET) {
      await upgradeToPremium(db, user.line_user_id);
      return '已升級為付費方案，獲得 1500 則對話額度！輸入「人設」可切換喜歡的人設 💛';
    }
    return null;
  }

  return null;
}

// 呼叫 Together AI Chat Completions API
async function callTogetherAI(user: UserState, text: string, c: any): Promise<string> {
  const db = c.env.DB as D1Database;
  const messages: { role: string; content: string }[] = [];

  if (user.plan === 'premium') {
    const persona = getPersona(user.persona);
    messages.push({ role: 'system', content: persona.premiumPrompt });

    const history = await getRecentMessages(db, user.line_user_id, 20);
    messages.push(...history);
  } else {
    messages.push({ role: 'system', content: FREE_SYSTEM_PROMPT });
  }

  messages.push({ role: 'user', content: text });

  const response = await fetch('https://api.together.xyz/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.TOGETHER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: c.env.TOGETHER_MODEL || 'Qwen/Qwen3.5-397B-A17B',
      messages,
      temperature: 0.8,
      // 聊天情境不需要 reasoning：關閉思考模式，避免大量思考 token 把回覆擠掉
      chat_template_kwargs: { enable_thinking: false },
      // 保險：就算思考模式仍開啟，也給足空間讓它想完並輸出回覆
      max_tokens: 8192
    })
  });

  if (!response.ok) {
    console.error('Together AI error:', response.status, await response.text());
    return "我現在沒辦法思考";
  }

  const data: any = await response.json();
  const message = data.choices?.[0]?.message;

  // reasoning 模型的 content 可能夾帶 <think> 標籤，需剝除
  const content: string = (message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  if (!content) {
    const finishReason = data.choices?.[0]?.finish_reason;
    console.error(`Together AI empty content (finish_reason: ${finishReason}), raw response:`, JSON.stringify(data).slice(0, 2000));
    return "我現在沒辦法思考";
  }

  return content;
}

// 貼圖回應（依人設與貼圖情緒區分語氣），不消耗對話額度也不呼叫 AI
type StickerEmotion = 'happy' | 'love' | 'sad' | 'thanks' | 'sorry' | 'default';

// LINE 官方預設貼圖（packageId:stickerId）-> 情緒分類
// 目前僅收錄少量已確認的項目；未命中時會 fallback 到 'default' 並記錄 log，
// 可依 wrangler tail 看到的「Unmapped sticker」逐步擴充這份對照表
const STICKER_EMOTION_MAP: Record<string, StickerEmotion> = {
  '1:1': 'happy',
  '1:2': 'happy',
  '1:3': 'love',
  '1:4': 'sad'
};

const STICKER_REPLIES: Record<StickerEmotion, Record<PersonaId, string[]>> = {
  happy: {
    chen: ['看起來心情不錯，真好。', '這份開心也傳染給我了。'],
    yan: ['哈哈看到你這麼開心，我也跟著笑了。', '好喜歡看你開心的樣子～'],
    ye: ['你笑起來的樣子，我猜一定很好看。', '心情好就好，別藏著。'],
    yu: ['哈哈哈這個太可愛了！心情也跟著飛起來～', '你開心我就開心，繼續保持喔！']
  },
  love: {
    chen: ['收到了，謝謝你。', '這份心意，我感受到了。'],
    yan: ['好喜歡這個，謝謝你想到我。', '收到滿滿的心意了，謝謝你。'],
    ye: ['嗯，收到了，藏不住的小心思。', '這個…我會記住的。'],
    yu: ['哇～被你這樣表達也太犯規了吧！', '收到愛心啦，今天心情瞬間變好！']
  },
  sad: {
    chen: ['怎麼了，發生什麼事了嗎？', '別擔心，我在這裡。'],
    yan: ['抱抱，是不是有點累了？想說的話我都在聽。', '聽起來不太好受，要不要跟我說說？'],
    ye: ['嗯…我在，不急著說也可以。', '看到了，今晚我會多想著你一點。'],
    yu: ['嘿嘿別難過啦，有我在呢！', '怎麼啦？跟我說說，我陪你！']
  },
  thanks: {
    chen: ['不用謝，這是我該做的。', '客氣了，能幫到你就好。'],
    yan: ['不用這麼說啦，能陪你就很好了。', '聽到謝謝，我也很開心呢。'],
    ye: ['嗯，不用謝。', '這點小事，別放在心上。'],
    yu: ['不客氣不客氣！隨時找我喔！', '哈哈舉手之勞，別這麼客氣～']
  },
  sorry: {
    chen: ['沒事的，別放在心上。', '了解，不用太自責。'],
    yan: ['沒關係的，我知道你不是故意的。', '別太在意，我都懂。'],
    ye: ['嗯，沒事。', '不用道歉，我沒有生氣。'],
    yu: ['哈哈沒事沒事，別放心上啦！', '小事一件，別在意喔！']
  },
  default: {
    chen: ['收到，看起來心情不錯。', '嗯，這個貼圖很有你的風格。'],
    yan: ['哈哈這個好可愛喔～', '收到啦，謝謝你跟我分享這個。'],
    ye: ['這個表情，倒是挺像你。', '嗯，看到了。'],
    yu: ['哈哈哈這個太好笑了吧！', '欸這個貼圖也太可愛了～']
  }
};

const FREE_STICKER_REPLIES: Record<StickerEmotion, string[]> = {
  happy: ['看起來心情不錯耶！', '這個貼圖好有活力～'],
  love: ['收到這個，謝謝你～', '好溫暖的貼圖。'],
  sad: ['怎麼了嗎？要不要說說看？', '別太累了，多休息一下。'],
  thanks: ['不用客氣～', '不會，是我該謝謝你才對。'],
  sorry: ['沒關係，別放在心上。', '沒事的啦。'],
  default: ['收到你的貼圖了，哈哈。', '這個表情很傳神耶。', '嗯嗯，看到了～']
};

async function handleSticker(c: any, userId: string, packageId: string, stickerId: string): Promise<string> {
  const db = c.env.DB as D1Database;
  const user = await getOrCreateUser(db, userId);

  const key = `${packageId}:${stickerId}`;
  const emotion = STICKER_EMOTION_MAP[key];
  if (!emotion) {
    console.log('Unmapped sticker:', key);
  }
  const category = emotion || 'default';

  const replies = user.plan === 'premium'
    ? (STICKER_REPLIES[category][user.persona] || STICKER_REPLIES[category].chen)
    : FREE_STICKER_REPLIES[category];

  return replies[Math.floor(Math.random() * replies.length)];
}

// 每日主動問候訊息（依人設區分語氣）
const DAILY_GREETINGS: Record<PersonaId, string[]> = {
  chen: ['早安，今天也要好好照顧自己。', '想到你了，今天過得還順利嗎？'],
  yan: ['早安☺️ 昨晚有睡好嗎？', '突然想跟你說聲早安，今天也要加油喔。'],
  ye: ['醒了嗎，剛剛想到你了。', '今天的天氣讓我想起你，在做什麼呢？'],
  yu: ['早安！新的一天也要元氣滿滿喔！☀️', '嘿，起床了嗎？今天想跟你聊點什麼呢～']
};

// 每日定時推播：對所有付費方案使用者主動問候
async function sendDailyGreetings(c: any): Promise<void> {
  const db = c.env.DB as D1Database;
  const userIds = await getPremiumUsers(db);

  await Promise.all(
    userIds.map(async (userId) => {
      const user = await getOrCreateUser(db, userId);
      const greetings = DAILY_GREETINGS[user.persona] || DAILY_GREETINGS.chen;
      const greeting = greetings[new Date().getDate() % greetings.length];

      await saveMessage(db, userId, 'assistant', greeting);
      await pushMessageToLine(userId, greeting, c).catch((e) =>
        console.error('Daily greeting push failed:', userId, e)
      );
    })
  );
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

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    const c = { env, executionCtx: ctx };
    ctx.waitUntil(sendDailyGreetings(c));
  }
};
