import { test } from "node:test";
import assert from "node:assert/strict";
import { verifySignature } from "../src/line.js";
import { sign, SECRET, makeEnv, makeApp, webhookRequest, textEvent } from "./helpers.js";

const body = JSON.stringify({ destination: "U1", events: [{ type: "message", message: { type: "text", text: "สวัสดี hello" } }] });

test("accepts the signature LINE computes (HMAC-SHA256 of the raw body, base64)", async () => {
  assert.equal(await verifySignature(SECRET, body, sign(body)), true);
});

test("rejects a signature made with another secret", async () => {
  assert.equal(await verifySignature(SECRET, body, sign(body, "other-secret")), false);
});

test("rejects a tampered body", async () => {
  assert.equal(await verifySignature(SECRET, body.replace("hello", "hellO"), sign(body)), false);
});

test("rejects missing, empty, garbage and wrong-length signatures", async () => {
  for (const s of [null, undefined, "", "not base64 !!", "AAAA", sign(body).slice(0, -4)]) {
    assert.equal(await verifySignature(SECRET, body, s), false, String(s));
  }
});

test("rejects everything when the channel secret is not configured", async () => {
  assert.equal(await verifySignature("", body, sign(body, "")), false);
  assert.equal(await verifySignature(undefined, body, sign(body)), false);
});

test("webhook answers 401 to a bad signature and sends nothing", async () => {
  const { app, line } = makeApp("2026-10-23T12:00:00Z");
  const res = await app.fetch(webhookRequest([textEvent("hello")], { signature: sign("something else") }), makeEnv());
  assert.equal(res.status, 401);
  assert.equal(line.calls.length, 0);
});

test("webhook answers 200 to LINE's Verify call (valid signature, no events)", async () => {
  const { app } = makeApp("2026-10-23T12:00:00Z");
  const res = await app.fetch(webhookRequest([]), makeEnv());
  assert.equal(res.status, 200);
});
