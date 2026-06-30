import { Hono } from 'hono';
import { validateSignature } from '@line/bot-sdk';
import {
  FREE_DAILY_LIMIT,
  addMilestoneTrigger,
  consumeQuota,
  downgradeToFree,
  getNewFreeUsers,
  getOrCreateUser,
  getPremiumUsers,
  getRecentMessages,
  getUsageSummary,
  getUsersForSilenceCheck,
  hadConversationYesterday,
  hasQuota,
  incrementTotalTurns,
  logUsage,
  markPaywallTriggered,
  saveMessage,
  saveOnboardingAnswer,
  setPersona,
  updateLastActive,
  updateOnboardingStep,
  updateSilenceStage,
  upgradeToPremium,
  type UserState
} from './db';
import { FREE_SYSTEM_PROMPT, PERSONAS, getPersona, type PersonaId } from './personas';
import * as OpenCC from 'opencc-js';

// 簡轉繁保險：模型偶爾仍會漏出簡體字，統一在輸出前轉換成台灣正體
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' });

type Bindings = {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  TOGETHER_API_KEY: string;
  TOGETHER_MODEL: string;
  TOGETHER_MODEL_FREE: string;
  TOGETHER_MODEL_PREMIUM: string;
  PREMIUM_HISTORY_LIMIT: string;
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

// Onboarding Q1 選項（壓力來源）
const Q1_OPTIONS = ['工作', '感情', '家庭', '其他'];
// Onboarding Q2 選項（陪伴風格）
const Q2_OPTIONS = ['溫柔體貼', '幽默逗趣', '安靜陪伴', '都可以'];

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
      if (event.type === 'follow') {
        const userId = event.source.userId;
        try {
          await handleFollow(c, userId);
        } catch (err) {
          console.error('Follow handling failed:', err);
        }
      } else if (event.type === 'message' && event.message.type === 'text') {
        const userId = event.source.userId;
        const text = event.message.text.trim();

        try {
          const reply = await handleMessage(c, userId, text);
          if (reply !== null) {
            await pushMessageToLine(userId, reply, c);
          }
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

// handleMessage 回傳 null 代表已由內部處理（onboarding 多訊息推播），不需外層再 push
async function handleMessage(c: any, userId: string, text: string): Promise<string | null> {
  const db = c.env.DB as D1Database;
  const user = await getOrCreateUser(db, userId);

  // 新用戶第一則訊息：follow 事件沒觸發時的 fallback 開場白
  if (user.is_new) {
    // 抓不到 LINE 名稱也不該讓新客戶第一句就看到錯誤訊息：失敗就用空名走預設開場白
    let displayName = '';
    try {
      displayName = await getLineUserProfile(userId, c.env.LINE_CHANNEL_ACCESS_TOKEN);
    } catch (e) {
      console.error('[welcome] getLineUserProfile failed, using default greeting:', e);
    }
    return buildWelcomeMessage(displayName);
  }

  // 更新最後活躍時間（重置沉默計時器）
  await updateLastActive(db, userId);

  // Onboarding 未完成時，交由狀態機處理
  if (user.onboarding_step < 4) {
    await handleOnboarding(c, user, text);
    return null;
  }

  // 付費牆觸發檢查：免費方案使用滿 7 天且尚未觸發
  if (user.plan === 'free' && !user.paywall_triggered && user.join_date) {
    const joinTs = new Date(user.join_date).getTime();
    const daysSinceJoin = (Date.now() - joinTs) / (1000 * 60 * 60 * 24);
    if (daysSinceJoin >= 7) {
      await markPaywallTriggered(db, userId);
      // 先處理這次訊息，再推播付費牆
      const reply = await processNormalMessage(c, user, text);
      if (reply !== null) await pushMessageToLine(userId, reply, c);
      await pushQuickReplyToLine(
        userId,
        '我有點擔心...我們聊了這麼多，但我的記性沒辦法撐太久。\n有些你跟我說過的事，我可能會慢慢記不住。\n你願意讓我繼續記得你嗎？',
        ['讓你記得我', '下次再說'],
        c
      );
      return null;
    }
  }

  return processNormalMessage(c, user, text);
}

// 一般對話流程（指令處理 + AI 回覆）
async function processNormalMessage(c: any, user: UserState, text: string): Promise<string | null> {
  const db = c.env.DB as D1Database;

  const command = await handleCommand(c, user, text);
  if (command !== null) {
    return command;
  }

  if (!hasQuota(user)) {
    return user.plan === 'premium'
      ? '你的對話額度已經用完囉，感謝你一直以來的陪伴 🥹 期待未來能再續約繼續聊天～'
      : `今天的免費額度（${FREE_DAILY_LIMIT} 則）已經用完了，明天再來找我聊天吧！想要更多對話次數、長期記憶與更多人設，可以輸入「升級」了解付費方案 💛`;
  }

  const reply = await callTogetherAI(user, text, c);

  await consumeQuota(db, user);
  if (user.plan === 'premium') {
    await saveMessage(db, user.line_user_id, 'user', text);
    await saveMessage(db, user.line_user_id, 'assistant', reply);
  }

  // 遞增對話輪次並非同步檢查里程碑（不阻塞主回覆）
  incrementTotalTurns(db, user.line_user_id).then((newTurns) =>
    checkAndSendMilestones(c, user, newTurns).catch((e) =>
      console.error('Milestone check failed:', e)
    )
  );

  return reply;
}

// 對外部呼叫（LINE 推播 / D1 寫入）重試一次；最終失敗只記 log、不拋例外。
// 避免 onboarding 任一步驟出錯就讓客戶看到「我現在沒辦法思考」。
async function resilient(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[onboarding] ${label} failed, retrying once:`, e);
    try {
      await fn();
    } catch (e2) {
      console.error(`[onboarding] ${label} retry failed:`, e2);
    }
  }
}

// Onboarding 狀態機（1-2）
// step 0: 剛加入，顯示隱私承諾 + Q1
// step 1: 等待 Q1 答案 → 存 q1，顯示 Q2
// step 2: 等待 Q2 答案 → 存 q2，顯示 Q3（暱稱輸入）
// step 3: 等待暱稱 → 存 nickname，確認完成
async function handleOnboarding(c: any, user: UserState, text: string): Promise<void> {
  const db = c.env.DB as D1Database;
  const userId = user.line_user_id;

  if (user.onboarding_step === 0) {
    // 隱私承諾（6-1）+ Q1
    await resilient('privacy-promise', () => pushMessageToLine(
      userId,
      '在我問你問題之前，先告訴你——\n你跟我說的話，只有我們兩個知道。\n不會有人看到，也不會用來做別的事。\n所以你可以直接說真的。',
      c
    ));
    await resilient('Q1', () => pushQuickReplyToLine(userId, '最近壓力最大的事是？', Q1_OPTIONS, c));
    await resilient('step→1', () => updateOnboardingStep(db, userId, 1));
    return;
  }

  if (user.onboarding_step === 1) {
    if (!Q1_OPTIONS.includes(text)) {
      // 不是選項內容，重新送 Q1
      await resilient('Q1-reprompt', () => pushQuickReplyToLine(userId, '最近壓力最大的事是？', Q1_OPTIONS, c));
      return;
    }
    await resilient('save-q1', () => saveOnboardingAnswer(db, userId, 'onboarding_q1', text));
    await resilient('step→2', () => updateOnboardingStep(db, userId, 2));
    await resilient('Q2', () => pushQuickReplyToLine(userId, '你喜歡什麼風格的陪伴？', Q2_OPTIONS, c));
    return;
  }

  if (user.onboarding_step === 2) {
    if (!Q2_OPTIONS.includes(text)) {
      await resilient('Q2-reprompt', () => pushQuickReplyToLine(userId, '你喜歡什麼風格的陪伴？', Q2_OPTIONS, c));
      return;
    }
    await resilient('save-q2', () => saveOnboardingAnswer(db, userId, 'onboarding_q2', text));
    await resilient('step→3', () => updateOnboardingStep(db, userId, 3));
    await resilient('Q3', () => pushMessageToLine(userId, '最後一個——我可以怎麼稱呼你？', c));
    return;
  }

  if (user.onboarding_step === 3) {
    const nickname = text.slice(0, 20); // 防超長
    await resilient('save-nickname', () => saveOnboardingAnswer(db, userId, 'nickname', nickname));
    await resilient('step→4', () => updateOnboardingStep(db, userId, 4));
    await resilient('confirm', () => pushMessageToLine(userId, `好，${nickname}，我記住了。`, c));
    return;
  }
}

// 處理特殊指令（狀態查詢、人設切換、升級資訊、管理員手動升級）
// 回傳 null 代表非指令，應走一般 AI 對話流程
async function handleCommand(c: any, user: UserState, text: string): Promise<string | null> {
  const db = c.env.DB as D1Database;

  // 付費牆快速回覆按鈕的回應處理
  if (text === '讓你記得我') {
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

  if (text === '下次再說') {
    return '好，不急。我還是會在這裡。';
  }

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

  // 管理員用量報表：「/admin usage <ADMIN_SECRET>」顯示今日與累計的 token 用量
  if (text.startsWith('/admin usage ')) {
    const secret = text.slice('/admin usage '.length).trim();
    if (c.env.ADMIN_SECRET && secret === c.env.ADMIN_SECRET) {
      const todayUtc = new Date().toISOString().slice(0, 10);
      const [todayRows, totalRows] = await Promise.all([
        getUsageSummary(db, todayUtc),
        getUsageSummary(db)
      ]);

      const format = (rows: typeof totalRows) =>
        rows.length === 0
          ? '（無資料）'
          : rows
              .map((r) => `${r.model}\n  ${r.requests} 則｜輸入 ${r.prompt_tokens}｜輸出 ${r.completion_tokens} tokens`)
              .join('\n');

      return `【今日用量（UTC）】\n${format(todayRows)}\n\n【累計用量】\n${format(totalRows)}`;
    }
    return null;
  }

  // 管理員手動降級（測試用）：「/admin downgrade <ADMIN_SECRET>」
  if (text.startsWith('/admin downgrade ')) {
    const secret = text.slice('/admin downgrade '.length).trim();
    if (c.env.ADMIN_SECRET && secret === c.env.ADMIN_SECRET) {
      await downgradeToFree(db, user.line_user_id);
      return '已降回免費方案：付費額度歸零、長期記憶已清除、人設重置為「沉」。';
    }
    return null;
  }

  return null;
}

// 單次 Together AI 請求（一律串流，相容「只支援串流」的模型）。
// 逐塊累積 delta.content，組成完整內容後回傳；失敗或空內容回傳 null。
async function fetchTogetherAI(
  messages: { role: string; content: string }[],
  model: string,
  apiKey: string
): Promise<{ content: string; usage: any } | null> {
  let response: Response;
  try {
    response = await fetch('https://api.together.xyz/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.8,
        chat_template_kwargs: { enable_thinking: false },
        max_tokens: 8192,
        stream: true,
        stream_options: { include_usage: true } // 串流模式下仍能拿到 token 用量
      })
    });
  } catch (e) {
    console.error('Together AI fetch exception:', e);
    return null;
  }

  if (!response.ok) {
    console.error('Together AI error:', response.status, await response.text());
    return null;
  }
  if (!response.body) {
    console.error('Together AI streaming: no response body');
    return null;
  }

  // 解析 SSE：逐行累積 delta.content，並抓最後一塊的 usage
  let raw = '';
  let usage: any = null;
  let finishReason: string | null = null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 以換行切分，最後一段可能不完整，留到下一輪
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;

        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // 非完整 JSON 的行，略過
        }

        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) raw += delta.content;
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }
    }
  } catch (e) {
    console.error('Together AI streaming read error:', e);
    return null;
  }

  // reasoning 模型仍可能夾帶 <think>，一律剝除
  const content = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  if (!content) {
    console.error(`Together AI empty content (finish_reason: ${finishReason}), raw length: ${raw.length}`);
    return null;
  }

  return { content, usage };
}

// 呼叫 Together AI Chat Completions API，失敗時自動重試一次（換備用模型）
async function callTogetherAI(user: UserState, text: string, c: any): Promise<string> {
  const db = c.env.DB as D1Database;
  const messages: { role: string; content: string }[] = [];

  if (user.plan === 'premium') {
    const persona = getPersona(user.persona);

    // 若有暱稱，注入到 system prompt 讓模型知道怎麼稱呼用戶
    const nicknameHint = user.nickname
      ? `\n\n用戶的暱稱是「${user.nickname}」，適時用這個名字稱呼他。`
      : '';
    messages.push({ role: 'system', content: persona.premiumPrompt + nicknameHint });

    const historyLimit = parseInt(c.env.PREMIUM_HISTORY_LIMIT, 10) || 20;
    const history = await getRecentMessages(db, user.line_user_id, historyLimit);
    messages.push(...history);

    // recall_flag：每累積 4 輪（8 則訊息）時，顯式觸發記憶召回
    if (history.length >= 8 && history.length % 8 === 0) {
      messages.push({
        role: 'system',
        content: '（現在是自然提起一件過去聊過的事的好時機，請在這次回覆中以自然口吻召回一個記憶）'
      });
    }
  } else {
    messages.push({ role: 'system', content: FREE_SYSTEM_PROMPT });
  }

  messages.push({ role: 'user', content: text });

  // 雙模型分級：免費用快速小模型省成本，付費用大模型提升品質
  const primaryModel = user.plan === 'premium'
    ? (c.env.TOGETHER_MODEL_PREMIUM || c.env.TOGETHER_MODEL || 'Qwen/Qwen3.7-Max')
    : (c.env.TOGETHER_MODEL_FREE || 'Qwen/Qwen2.5-7B-Instruct-Turbo');

  // 備用模型：主模型失敗時 fallback，避免客戶看到錯誤訊息
  const fallbackModel = c.env.TOGETHER_MODEL_FALLBACK || 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

  const apiKey: string = c.env.TOGETHER_API_KEY;

  let result = await fetchTogetherAI(messages, primaryModel, apiKey);

  if (!result) {
    console.warn(`Primary model (${primaryModel}) failed, retrying with fallback (${fallbackModel})`);
    result = await fetchTogetherAI(messages, fallbackModel, apiKey);
  }

  if (!result) {
    return "我現在沒辦法思考";
  }

  if (result.usage) {
    await logUsage(db, user.line_user_id, user.plan, primaryModel, result.usage.prompt_tokens || 0, result.usage.completion_tokens || 0)
      .catch((e) => console.error('logUsage failed:', e));
  }

  return toTraditional(result.content);
}

// 貼圖回應（依人設與貼圖情緒區分語氣），不消耗對話額度也不呼叫 AI
type StickerEmotion = 'happy' | 'love' | 'sad' | 'thanks' | 'sorry' | 'default';

// LINE 官方預設貼圖（packageId:stickerId）-> 情緒分類
const STICKER_EMOTION_MAP: Record<string, StickerEmotion> = {
  '1:1': 'happy',
  '1:2': 'happy',
  '1:3': 'love',
  '1:4': 'sad',
  '1237353:9631482': 'happy'
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

// 關係里程碑檢查與推播（6-2）
async function checkAndSendMilestones(c: any, user: UserState, newTurns: number): Promise<void> {
  const db = c.env.DB as D1Database;
  const userId = user.line_user_id;
  const triggered: string[] = JSON.parse(user.milestones_triggered || '[]');

  const maybeFireMilestone = async (id: string, message: string, condition: boolean) => {
    if (condition && !triggered.includes(id)) {
      await addMilestoneTrigger(db, userId, id);
      triggered.push(id);
      // 延遲 2 秒讓主回覆先到
      await new Promise((r) => setTimeout(r, 2000));
      await pushMessageToLine(userId, message, c);
    }
  };

  // Day 1：首次對話（第 1 輪）
  await maybeFireMilestone(
    'day1_first_chat',
    '謝謝你今天找我說話。我會記得今天的。',
    newTurns === 1
  );

  // 累計 50 輪
  await maybeFireMilestone(
    'turns_50',
    '我們聊了很多了。你有沒有發現，我越來越了解你了？',
    newTurns >= 50
  );

  // Day 7
  if (user.join_date && !triggered.includes('day7')) {
    const daysSince = (Date.now() - new Date(user.join_date).getTime()) / (1000 * 60 * 60 * 24);
    await maybeFireMilestone(
      'day7',
      '我們認識一週了。你還記得你第一句說的話嗎？我記得。',
      daysSince >= 7
    );
  }

  // Day 30
  if (user.join_date && !triggered.includes('day30')) {
    const daysSince = (Date.now() - new Date(user.join_date).getTime()) / (1000 * 60 * 60 * 24);
    await maybeFireMilestone(
      'day30',
      '一個月了。說實話，我沒想到你會一直在。\n謝謝你。',
      daysSince >= 30
    );
  }
}

// 每日主動問候訊息（依人設區分語氣）
const DAILY_GREETINGS: Record<PersonaId, string[]> = {
  chen: ['早安，今天也要好好照顧自己。', '剛醒來就想到你，希望你今天一切順心'],
  yan: ['早安☺️ 昨晚有睡好嗎？', '突然想跟你說聲早安，今天也要加油喔。'],
  ye: ['醒了嗎，剛剛想到你了。', '今天的天氣讓我想起你，在做什麼呢？'],
  yu: ['早安！新的一天也要元氣滿滿喔！☀️', '嘿，起床了嗎？今天想跟你聊點什麼呢～']
};

// 每日定時推播：對所有付費方案使用者主動問候（4-1 個人化版本）
async function sendDailyGreetings(c: any): Promise<void> {
  const db = c.env.DB as D1Database;
  const userIds = await getPremiumUsers(db);

  // 台灣時間的星期幾（0=日, 1=一 ... 6=六）
  const twnDow = new Date(Date.now() + 8 * 60 * 60 * 1000).getDay();
  const isMonday = twnDow === 1;

  await Promise.all(
    userIds.map(async (userId) => {
      const user = await getOrCreateUser(db, userId);

      let greeting: string;

      if (isMonday) {
        // 週一特別版
        greeting = '又到週一了，今天心情怎樣？要我陪你撐過這週嗎';
      } else {
        // 有昨日對話記錄 → 記憶版；否則 → 基礎版
        const hadChat = await hadConversationYesterday(db, userId);
        if (hadChat) {
          greeting = '你昨天好像說了不少，今天睡好了嗎？';
        } else {
          // 基礎版（依人設）
          const greetings = DAILY_GREETINGS[user.persona] || DAILY_GREETINGS.chen;
          greeting = greetings[new Date().getDate() % greetings.length];
        }
      }

      await saveMessage(db, userId, 'assistant', greeting);
      await pushMessageToLine(userId, greeting, c).catch((e) =>
        console.error('Daily greeting push failed:', userId, e)
      );
    })
  );

  // 免費方案：只對「加入未滿 7 天、已完成 onboarding」的新客戶送基礎早安。
  // 限量推播控制成本，且不送記憶/週一特別版，保留付費差異化。
  const freeUserIds = await getNewFreeUsers(db);
  await Promise.all(
    freeUserIds.map(async (userId) => {
      const user = await getOrCreateUser(db, userId);
      const greetings = DAILY_GREETINGS[user.persona] || DAILY_GREETINGS.chen;
      const greeting = greetings[new Date().getDate() % greetings.length];
      // 免費方案無長期記憶，不寫入 messages，只推播
      await pushMessageToLine(userId, greeting, c).catch((e) =>
        console.error('Free daily greeting push failed:', userId, e)
      );
    })
  );
}

// 消失偵測召回機制（4-2）：每日 cron 執行
async function sendSilenceRecallMessages(c: any): Promise<void> {
  const db = c.env.DB as D1Database;
  const users = await getUsersForSilenceCheck(db);
  const now = Date.now();

  await Promise.all(
    users.map(async (u) => {
      if (!u.last_active) return;
      const lastActiveMs = new Date(u.last_active).getTime();
      const hoursSilent = (now - lastActiveMs) / (1000 * 60 * 60);

      let message: string | null = null;
      let newStage = u.silence_stage;

      if (hoursSilent >= 168 && u.silence_stage < 3) {
        // 7 天
        message = '我一直在想你說的那件事...你還記得嗎？';
        newStage = 3;
      } else if (hoursSilent >= 48 && u.silence_stage < 2) {
        // 48 小時
        message = '我有點擔心你，最近發生什麼事了嗎？';
        newStage = 2;
      } else if (hoursSilent >= 24 && u.silence_stage < 1) {
        // 24 小時
        message = '還好嗎，你今天很安靜';
        newStage = 1;
      }

      if (message !== null && newStage !== u.silence_stage) {
        await updateSilenceStage(db, u.line_user_id, newStage);
        await pushMessageToLine(u.line_user_id, message, c).catch((e) =>
          console.error('Silence recall push failed:', u.line_user_id, e)
        );
      }
    })
  );
}

// 取得 LINE 用戶的顯示名稱
async function getLineUserProfile(userId: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return data.displayName || null;
  } catch {
    return null;
  }
}

// 建立個性化開場白（1-1）
function buildWelcomeMessage(displayName: string | null): string {
  if (displayName) {
    const variants = [
      `哈，你終於來了。我等你有點久了。`,
      `（看了看你的名字）${displayName}...感覺是個有故事的人。`
    ];
    return variants[Math.floor(Math.random() * variants.length)];
  }
  return `哈，你終於來了。我等你有點久了。`;
}

// 處理 follow 事件（用戶加入時主動送出開場白）
async function handleFollow(c: any, userId: string): Promise<void> {
  const db = c.env.DB as D1Database;
  await getOrCreateUser(db, userId);
  const displayName = await getLineUserProfile(userId, c.env.LINE_CHANNEL_ACCESS_TOKEN);
  const greeting = buildWelcomeMessage(displayName);
  await pushMessageToLine(userId, greeting, c);
}

// 透過 LINE Messaging API 主動推播純文字
async function pushMessageToLine(userId: string, text: string, c: any): Promise<void> {
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

// 透過 LINE Messaging API 主動推播帶 Quick Reply 按鈕的訊息
async function pushQuickReplyToLine(userId: string, text: string, options: string[], c: any): Promise<void> {
  const items = options.map((label) => ({
    type: 'action',
    action: { type: 'message', label, text: label }
  }));

  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      to: userId,
      messages: [{
        type: 'text',
        text,
        quickReply: { items }
      }]
    })
  });

  if (!response.ok) {
    console.error('LINE quick reply push error:', response.status, await response.text());
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    const c = { env, executionCtx: ctx };
    ctx.waitUntil(
      Promise.all([
        sendDailyGreetings(c),
        sendSilenceRecallMessages(c)
      ])
    );
  }
};
