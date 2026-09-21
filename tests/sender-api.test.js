const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { createSenderRouter } = require("../lib/sender-api.js");
const { createStatusStore } = require("../lib/sender-status.js");

const PIN = "1234";

async function withServer(deps, fn) {
  const statusStore = deps.statusStore || createStatusStore();
  const app = express();
  app.use("/api/sender", createSenderRouter({
    pin: PIN,
    loadAccounts: async () => new Map([
      ["97422222222", { number: "97422222222", name: "Zed", paid: false }],
      ["97411111111", { number: "97411111111", name: "Ahmed", paid: true }],
    ]),
    polish: async () => ({ ok: true, draft: "Polished." }),
    sendMessage: async () => ({ ok: true, id: "wamid.1" }),
    ...deps,
    statusStore,
  }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/sender`;
  const call = (path, { method = "GET", body, pin = PIN } = {}) =>
    fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(pin !== null ? { "X-Sender-Pin": pin } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
  try { await fn(call, statusStore); } finally { server.close(); }
}

test("disabled when no PIN is configured", async () => {
  await withServer({ pin: "" }, async (call) => {
    const r = await call("/contacts");
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "sender_disabled");
  });
});

test("wrong or missing PIN is 401", async () => {
  await withServer({}, async (call) => {
    assert.equal((await call("/contacts", { pin: "9999" })).status, 401);
    assert.equal((await call("/contacts", { pin: null })).status, 401);
  });
});

test("contacts come back sorted by name", async () => {
  await withServer({}, async (call) => {
    const r = await call("/contacts");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.contacts, [
      { number: "97411111111", name: "Ahmed" },
      { number: "97422222222", name: "Zed" },
    ]);
  });
});

test("contacts: sheet failure is 502", async () => {
  await withServer({ loadAccounts: async () => { throw new Error("quota"); } }, async (call) => {
    const r = await call("/contacts");
    assert.equal(r.status, 502);
    assert.equal(r.json.error, "sheet_unavailable");
  });
});

test("polish validates input and passes it through", async () => {
  let got;
  await withServer({ polish: async (o) => { got = o; return { ok: true, draft: "مرحبا" }; } }, async (call) => {
    assert.equal((await call("/polish", { method: "POST", body: { text: "  ", language: "en" } })).json.error, "empty_text");
    assert.equal((await call("/polish", { method: "POST", body: { text: "hi", language: "fr" } })).json.error, "bad_language");
    const r = await call("/polish", { method: "POST", body: { text: " hi ", language: "ar", instruction: " shorter " } });
    assert.equal(r.status, 200);
    assert.equal(r.json.draft, "مرحبا");
    assert.deepEqual(got, { text: "hi", language: "ar", instruction: "shorter" });
  });
});

test("polish: AI unavailable is 503 with the reason", async () => {
  await withServer({ polish: async () => ({ ok: false, message: "credits exhausted" }) }, async (call) => {
    const r = await call("/polish", { method: "POST", body: { text: "hi", language: "en" } });
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { error: "ai_unavailable", message: "credits exhausted" });
  });
});

test("send normalises the number, validates, and tracks the wamid", async () => {
  let sentTo;
  await withServer({ sendMessage: async (to) => { sentTo = to; return { ok: true, id: "wamid.9" }; } }, async (call, store) => {
    assert.equal((await call("/send", { method: "POST", body: { to: "+974 123", text: "x" } })).json.error, "bad_number");
    assert.equal((await call("/send", { method: "POST", body: { to: "97411111111", text: " " } })).json.error, "empty_text");
    assert.equal((await call("/send", { method: "POST", body: { to: "97411111111", text: "a".repeat(4097) } })).json.error, "too_long");
    const r = await call("/send", { method: "POST", body: { to: "+974 1111-1111", text: "Hello" } });
    assert.deepEqual(r.json, { ok: true, id: "wamid.9" });
    assert.equal(sentTo, "97411111111");
    assert.equal(store.get("wamid.9").status, "pending");
  });
});

test("send: Graph error is 502 with outsideWindow flag", async () => {
  await withServer({ sendMessage: async () => ({ ok: false, code: 131047, message: "Re-engagement" }) }, async (call) => {
    const r = await call("/send", { method: "POST", body: { to: "97411111111", text: "Hello" } });
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { ok: false, code: 131047, message: "Re-engagement", outsideWindow: true });
  });
});

test("status reports the store and 404s unknown ids", async () => {
  await withServer({}, async (call, store) => {
    store.track("wamid.5");
    store.record({ id: "wamid.5", status: "failed", errors: [{ code: 131047, title: "Re-engagement message" }] });
    const r = await call("/status/wamid.5");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { status: "failed", code: 131047, message: "Re-engagement message", outsideWindow: true });
    const u = await call("/status/nope");
    assert.equal(u.status, 404);
    assert.equal(u.json.status, "unknown");
  });
});
