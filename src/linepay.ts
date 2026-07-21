// LINE Pay Online API v3 客戶端（Request / Confirm）
export interface LinePayBindings {
  LINE_PAY_CHANNEL_ID: string;
  LINE_PAY_CHANNEL_SECRET: string;
  LINE_PAY_ENV: string; // 'sandbox' | 'production'
}

const API_BASE: Record<string, string> = {
  sandbox: 'https://sandbox-api-pay.line.me',
  production: 'https://api-pay.line.me'
};

function apiBase(env: LinePayBindings): string {
  return API_BASE[env.LINE_PAY_ENV] || API_BASE.sandbox;
}

async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// 簽章規則：Base64(HMAC-SHA256(channelSecret, channelSecret + uri + requestBody + nonce))
async function linePayFetch(
  env: LinePayBindings,
  uri: string,
  body: Record<string, unknown>
): Promise<any> {
  const nonce = crypto.randomUUID();
  const requestBody = JSON.stringify(body);
  const signature = await hmacSha256Base64(
    env.LINE_PAY_CHANNEL_SECRET,
    env.LINE_PAY_CHANNEL_SECRET + uri + requestBody + nonce
  );

  const res = await fetch(`${apiBase(env)}${uri}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LINE-ChannelId': env.LINE_PAY_CHANNEL_ID,
      'X-LINE-Authorization-Nonce': nonce,
      'X-LINE-Authorization': signature
    },
    body: requestBody
  });

  const data: any = await res.json();
  if (!res.ok || data.returnCode !== '0000') {
    console.error('LINE Pay API error:', uri, res.status, JSON.stringify(data));
  }
  return data;
}

export interface LinePayRequestResult {
  ok: boolean;
  paymentUrl?: string;
  transactionId?: string;
  returnCode?: string;
  returnMessage?: string;
}

// 建立付款請求，回傳付款頁網址（給使用者跳轉去 LINE Pay 付款）
export async function createLinePayRequest(
  env: LinePayBindings,
  params: { orderId: string; amount: number; productName: string; confirmUrl: string; cancelUrl: string }
): Promise<LinePayRequestResult> {
  const data = await linePayFetch(env, '/v3/payments/request', {
    amount: params.amount,
    currency: 'TWD',
    orderId: params.orderId,
    packages: [
      {
        id: 'premium-plan',
        amount: params.amount,
        name: '心辰付費方案',
        products: [{ name: params.productName, quantity: 1, price: params.amount }]
      }
    ],
    redirectUrls: {
      confirmUrl: params.confirmUrl,
      cancelUrl: params.cancelUrl
    }
  });

  if (data.returnCode !== '0000') {
    return { ok: false, returnCode: data.returnCode, returnMessage: data.returnMessage };
  }

  return {
    ok: true,
    paymentUrl: data.info?.paymentUrl?.web,
    transactionId: String(data.info?.transactionId)
  };
}

export interface LinePayConfirmResult {
  ok: boolean;
  returnCode?: string;
  returnMessage?: string;
}

// 確認付款：使用者在 LINE Pay 完成付款導回後呼叫，才算真正扣款成功
export async function confirmLinePayPayment(
  env: LinePayBindings,
  transactionId: string,
  amount: number
): Promise<LinePayConfirmResult> {
  const data = await linePayFetch(env, `/v3/payments/${transactionId}/confirm`, {
    amount,
    currency: 'TWD'
  });

  return { ok: data.returnCode === '0000', returnCode: data.returnCode, returnMessage: data.returnMessage };
}
