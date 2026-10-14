// Test helpers: a D1-compatible wrapper around node:sqlite, a fake LINE API and signed webhook requests.
import fs from "node:fs";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";

const root = new URL("../", import.meta.url);
export const program = JSON.parse(fs.readFileSync(new URL("source/program.json", root), "utf8"));
const schema = fs.readFileSync(new URL("schema.sql", root), "utf8");

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) {
    for (const a of args) if (a === undefined) throw new Error("D1_TYPE_ERROR: undefined bound in " + this.sql);
    return new Stmt(this.db, this.sql, args);
  }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map(r => ({ ...r })) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes) } }; }
}

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  return { prepare: sql => new Stmt(db, sql), batch: async stmts => { const out = []; for (const st of stmts) out.push(await st.run()); return out; }, raw: db };
}

export const SECRET = "test-channel-secret";
export const OWNER = "U0123456789abcdef0123456789abcdef";
export const TOKEN = "test-api-token-0123456789abcdef";

export function makeEnv(overrides = {}) {
  return {
    DB: makeD1(), TZ: "Asia/Bangkok", PUSH_MONTHLY_LIMIT: "250", PUBLIC_URL: "",
    LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: "line-token", OWNER_LINE_USER_ID: OWNER, API_TOKEN: TOKEN,
    ...overrides,
  };
}

/** Fake fetch that records LINE API calls. */
export function makeLine() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith("/message/quota")) return new Response(JSON.stringify({ type: "limited", value: 300 }));
    if (String(url).endsWith("/quota/consumption")) return new Response(JSON.stringify({ totalUsage: 12 }));
    return new Response("{}");
  };
  return { calls, fetchImpl, replies: () => calls.filter(c => c.url.endsWith("/reply")), pushes: () => calls.filter(c => c.url.endsWith("/push")) };
}

/** App with a fixed clock. `at` is an ISO instant. */
export function makeApp(at, line = makeLine()) {
  const clock = { now: new Date(at) };
  const app = createApp({ program, dashboardHtml: "<html>dashboard</html>", fetchImpl: line.fetchImpl, now: () => clock.now });
  return { app, line, clock };
}

export const sign = (body, secret = SECRET) => crypto.createHmac("sha256", secret).update(body).digest("base64");

export function webhookRequest(events, { secret = SECRET, signature } = {}) {
  const body = JSON.stringify({ destination: "Uxxx", events });
  return new Request("https://road-to-scratch.example.workers.dev/line/webhook", {
    method: "POST", body, headers: { "content-type": "application/json", "x-line-signature": signature ?? sign(body, secret) },
  });
}

let n = 0;
export const textEvent = (text, userId = OWNER) => ({ type: "message", replyToken: "rt" + ++n, source: { type: "user", userId }, message: { type: "text", id: String(n), text } });
export const postbackEvent = (data, userId = OWNER) => ({ type: "postback", replyToken: "rt" + ++n, source: { type: "user", userId }, postback: { data } });
