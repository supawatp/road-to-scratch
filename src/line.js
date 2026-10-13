// LINE Messaging API: webhook signature check and a small reply/push client.

const enc = new TextEncoder();

function b64ToBytes(b64) {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * X-Line-Signature = base64(HMAC-SHA256(channel secret, raw request body)).
 * Uses crypto.subtle.verify, which compares in constant time.
 */
export async function verifySignature(secret, rawBody, signature) {
  if (!secret || !signature || typeof rawBody !== "string") return false;
  const sig = b64ToBytes(signature.trim());
  if (!sig || sig.length !== 32) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, enc.encode(rawBody));
}

const API = "https://api.line.me/v2/bot";

export class LineClient {
  constructor(token, fetchImpl = (...a) => fetch(...a)) {
    this.token = token;
    this.fetch = fetchImpl;
  }

  async call(method, path, body) {
    if (!this.token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set");
    const res = await this.fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`LINE ${method} ${path} -> ${res.status} ${detail.slice(0, 300)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  /** Reply messages are free; LINE allows at most 5 per reply. */
  reply(replyToken, messages) {
    return this.call("POST", "/message/reply", { replyToken, messages: toMessages(messages).slice(0, 5) });
  }

  /** Push messages count toward the monthly quota. */
  push(to, messages) {
    return this.call("POST", "/message/push", { to, messages: toMessages(messages).slice(0, 5) });
  }

  async quota() {
    const [q, used] = await Promise.all([this.call("GET", "/message/quota"), this.call("GET", "/message/quota/consumption")]);
    return { type: q.type, limit: q.value ?? null, used: used.totalUsage ?? 0 };
  }
}

/** Accepts strings or message objects; splits long text into LINE's 5000-character limit. */
export function toMessages(messages) {
  const out = [];
  for (const m of [].concat(messages)) {
    if (typeof m !== "string") { out.push(m); continue; }
    for (let i = 0; i < m.length || i === 0; i += 4900) out.push({ type: "text", text: m.slice(i, i + 4900) || " " });
  }
  return out;
}
