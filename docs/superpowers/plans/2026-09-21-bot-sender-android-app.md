# Bot Sender Android App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sideloaded Android app that sends WhatsApp messages from the bot's Cloud API number, with optional Claude Haiku polishing in English or Arabic.

**Architecture:** The existing Node/Express bot gains a PIN-protected `/api/sender` router (contacts, polish, send, status). Because Meta reports the 24-hour-window rejection (`131047`) asynchronously, the webhook records message statuses into an in-memory store that the app polls. The Android app is a single-activity Kotlin/Jetpack Compose client of that API.

**Tech Stack:** Node 24, Express 4, `node:test`, `@anthropic-ai/sdk`, axios · Kotlin 2.0.21, AGP 8.7.3, Gradle 8.10.2, Compose BOM 2024.12.01, OkHttp 4.12.0, kotlinx.serialization 1.7.3, androidx.security-crypto 1.1.0-alpha06, JUnit 4.

**Spec:** `docs/superpowers/specs/2026-09-21-bot-sender-android-app-design.md`

## Global Constraints

- Auth header name: `X-Sender-Pin`; env var: `SENDER_PIN`. Unset/empty → every sender route `503 {"error":"sender_disabled"}`.
- Router mount path: `/api/sender`.
- Outside-window Graph error code: `131047`.
- Polish model: `claude-haiku-4-5-20251001`, `max_tokens: 600`. Languages: `"en"` | `"ar"` only.
- WhatsApp text limit: 4096 chars. Minimum phone digits: 8. Numbers are digits-only (same rule as `lib/accounts.js` `normalizeNumber`).
- Status store TTL: 1 hour. App status polling: every 1.5 s, max 10 polls (15 s).
- Android: `minSdk 26`, `compileSdk 35`, `targetSdk 35`, package `com.mannai.botsender`, app name "Bot Sender".
- Android project lives in a **new standalone repo** at `C:\Users\HP\OneDrive\Claude AI\WhatsAppSender`.
- WhatsAppBot repo: **never `git add -A` / `git add .`** — untracked credential files sit in the repo root. Always add explicit paths.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Downloading the Android SDK, accepting its licenses, pushing to `main` (triggers Render deploy) and setting Render env vars each need the user's explicit yes in chat first.

---

## File Map

**WhatsAppBot (server):**
| File | Responsibility |
|---|---|
| `lib/sender-status.js` (new) | In-memory wamid → status store, fed by webhook |
| `lib/sender-polish.js` (new) | Build + run the Haiku polishing request |
| `lib/sender-api.js` (new) | Express router: auth, contacts, polish, send, status |
| `lib/wa.js` (modify) | Add `sendTextDetailed()` returning wamid / Graph error |
| `server.js` (modify) | Mount router; feed `value.statuses` into the store |
| `tests/sender-status.test.js`, `tests/sender-polish.test.js`, `tests/sender-api.test.js`, `tests/wa-send-detailed.test.js` (new) | Unit tests |

**WhatsAppSender (Android, `app/src/main/java/com/mannai/botsender/`):**
| File | Responsibility |
|---|---|
| `PhoneNumbers.kt` | Normalise/validate/display numbers |
| `Recipient.kt` | `Recipient` model + `RecipientList.merge` |
| `ApiModels.kt` | Serializable DTOs + `ApiResult` + `ErrorMapper` |
| `SenderApi.kt` | OkHttp client for the 4 endpoints |
| `Stores.kt` | `SettingsStore` (encrypted URL+PIN), `FavouritesStore` |
| `ComposeViewModel.kt` | UI state + actions (load, polish, undo, send, poll) |
| `ui/SetupScreen.kt`, `ui/ComposeScreen.kt`, `MainActivity.kt` | Compose UI |

---

### Task 1: Sender status store

**Files:**
- Create: `lib/sender-status.js`
- Test: `tests/sender-status.test.js`

**Interfaces:**
- Produces: `createStatusStore({ now? }) → { track(id), record(statusEvent), get(id) }`. `get` returns `null` or `{ status, ts, code?, message?, outsideWindow? }`. `status ∈ "pending"|"sent"|"delivered"|"read"|"failed"`. `record` accepts a Meta webhook status object `{ id, status, errors?: [{ code, title, message, error_data?: { details } }] }` and ignores ids that were never `track`ed.

- [ ] **Step 1: Write the failing test** — `tests/sender-status.test.js`

```js
const test = require("node:test");
const assert = require("node:assert");
const { createStatusStore } = require("../lib/sender-status.js");

test("tracked id starts pending", () => {
  const s = createStatusStore();
  s.track("wamid.1");
  assert.equal(s.get("wamid.1").status, "pending");
});

test("untracked ids are ignored (bot's own replies also produce statuses)", () => {
  const s = createStatusStore();
  s.record({ id: "wamid.other", status: "delivered" });
  assert.equal(s.get("wamid.other"), null);
});

test("status only moves forward: sent -> delivered -> read", () => {
  const s = createStatusStore();
  s.track("w");
  s.record({ id: "w", status: "delivered" });
  s.record({ id: "w", status: "sent" }); // late, out-of-order event
  assert.equal(s.get("w").status, "delivered");
  s.record({ id: "w", status: "read" });
  assert.equal(s.get("w").status, "read");
});

test("failed 131047 is flagged outsideWindow and is terminal", () => {
  const s = createStatusStore();
  s.track("w");
  s.record({
    id: "w", status: "failed",
    errors: [{ code: 131047, title: "Re-engagement message", error_data: { details: "More than 24 hours have passed" } }],
  });
  s.record({ id: "w", status: "delivered" });
  const got = s.get("w");
  assert.equal(got.status, "failed");
  assert.equal(got.code, 131047);
  assert.equal(got.outsideWindow, true);
  assert.equal(got.message, "More than 24 hours have passed");
});

test("other failures are not outsideWindow", () => {
  const s = createStatusStore();
  s.track("w");
  s.record({ id: "w", status: "failed", errors: [{ code: 131026, title: "Message undeliverable" }] });
  assert.equal(s.get("w").outsideWindow, false);
  assert.equal(s.get("w").message, "Message undeliverable");
});

test("entries expire after one hour", () => {
  let t = 0;
  const s = createStatusStore({ now: () => t });
  s.track("w");
  t = 60 * 60 * 1000 + 1;
  assert.equal(s.get("w"), null);
});

test("bad input never throws", () => {
  const s = createStatusStore();
  s.record(null);
  s.record({});
  s.track(undefined);
  assert.equal(s.get(undefined), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/sender-status.test.js`
Expected: FAIL — `Cannot find module '../lib/sender-status.js'`

- [ ] **Step 3: Implement** — `lib/sender-status.js`

```js
// ============================================================
//  Delivery status of messages sent from the Bot Sender app.
//
//  The Cloud API accepts a free-form message (HTTP 200 + wamid)
//  even when the recipient is outside the 24-hour window; the
//  rejection (code 131047) only arrives later as a webhook
//  `statuses` event. The webhook feeds this store and the app
//  polls /api/sender/status/:id for the outcome.
//
//  Only ids the sender tracked are kept — every bot reply also
//  produces statuses and we don't want to hold those.
// ============================================================
const TTL_MS = 60 * 60 * 1000;
const OUTSIDE_WINDOW_CODE = 131047;
const RANK = { pending: 0, sent: 1, delivered: 2, read: 3 };

function createStatusStore({ now = Date.now } = {}) {
  const entries = new Map(); // wamid -> { status, ts, code?, message?, outsideWindow? }

  function purge() {
    const t = now();
    for (const [id, e] of entries) if (t - e.ts > TTL_MS) entries.delete(id);
  }

  function track(id) {
    if (!id || entries.has(id)) return;
    entries.set(id, { status: "pending", ts: now() });
  }

  function record(event) {
    if (!event?.id || !event.status) return;
    purge();
    const prev = entries.get(event.id);
    if (!prev || prev.status === "failed") return;

    if (event.status === "failed") {
      const err = event.errors?.[0] || {};
      entries.set(event.id, {
        status: "failed",
        ts: prev.ts,
        code: err.code ?? null,
        message: err.error_data?.details || err.message || err.title || "Delivery failed",
        outsideWindow: err.code === OUTSIDE_WINDOW_CODE,
      });
      return;
    }
    const rank = RANK[event.status];
    if (rank === undefined || rank <= RANK[prev.status]) return;
    entries.set(event.id, { status: event.status, ts: prev.ts });
  }

  function get(id) {
    purge();
    return (id && entries.get(id)) || null;
  }

  return { track, record, get };
}

module.exports = { createStatusStore, OUTSIDE_WINDOW_CODE };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/sender-status.test.js`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/sender-status.js tests/sender-status.test.js
git commit -m "feat(sender): status store for app-sent messages

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Draft polishing (Claude Haiku)

**Files:**
- Create: `lib/sender-polish.js`
- Test: `tests/sender-polish.test.js`

**Interfaces:**
- Produces: `buildPolishRequest({ text, language, instruction }) → Anthropic messages.create params`; `async polishDraft(client, { text, language, instruction }) → string` (trimmed text; throws whatever the SDK throws). `POLISH_MODEL` constant.

- [ ] **Step 1: Write the failing test** — `tests/sender-polish.test.js`

```js
const test = require("node:test");
const assert = require("node:assert");
const { buildPolishRequest, polishDraft, POLISH_MODEL } = require("../lib/sender-polish.js");

test("request uses Haiku with a bounded reply", () => {
  const req = buildPolishRequest({ text: "hi", language: "en" });
  assert.equal(req.model, "claude-haiku-4-5-20251001");
  assert.equal(POLISH_MODEL, req.model);
  assert.equal(req.max_tokens, 600);
});

test("English vs Arabic is stated in the system prompt", () => {
  assert.match(buildPolishRequest({ text: "x", language: "en" }).system, /in English/);
  assert.match(buildPolishRequest({ text: "x", language: "ar" }).system, /in Arabic/);
});

test("user note is passed verbatim; instruction only when given", () => {
  const plain = buildPolishRequest({ text: "submittal ready", language: "en" });
  assert.equal(plain.messages.length, 1);
  assert.match(plain.messages[0].content, /submittal ready/);
  assert.doesNotMatch(plain.messages[0].content, /Extra instruction/);

  const withInstr = buildPolishRequest({ text: "submittal ready", language: "en", instruction: "shorter" });
  assert.match(withInstr.messages[0].content, /Extra instruction: shorter/);
});

test("polishDraft returns the joined, trimmed text blocks", async () => {
  let seen;
  const fake = { messages: { create: async (p) => { seen = p; return { content: [{ type: "text", text: "  Hello Ahmed.  " }] }; } } };
  const out = await polishDraft(fake, { text: "tell ahmed hello", language: "en" });
  assert.equal(out, "Hello Ahmed.");
  assert.equal(seen.model, POLISH_MODEL);
});

test("polishDraft propagates SDK errors (caller decides credit handling)", async () => {
  const fake = { messages: { create: async () => { throw Object.assign(new Error("boom"), { status: 500 }); } } };
  await assert.rejects(polishDraft(fake, { text: "x", language: "en" }), /boom/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/sender-polish.test.js`
Expected: FAIL — `Cannot find module '../lib/sender-polish.js'`

- [ ] **Step 3: Implement** — `lib/sender-polish.js`

```js
// ============================================================
//  "Polish with AI" for the Bot Sender app: turn the owner's
//  rough note into a clean WhatsApp message. Text-only, so it
//  runs on Haiku (vision work stays on Sonnet — see memory).
// ============================================================
const POLISH_MODEL = "claude-haiku-4-5-20251001";

const LANGUAGE_NAMES = { en: "English", ar: "Arabic" };

function buildPolishRequest({ text, language, instruction }) {
  const lang = LANGUAGE_NAMES[language] || "English";
  const system =
    `You write WhatsApp messages on behalf of an HVAC equipment supplier (Mannai). ` +
    `Rewrite the user's note as a clear, polite, concise WhatsApp message in ${lang}. ` +
    `Keep every fact, number, model code, date and name exactly as given. ` +
    `Do not invent details, prices, promises or signatures. ` +
    `Output only the message text — no quotes, no preamble, no explanation.`;
  let content = `Note to turn into a message:\n${text}`;
  if (instruction) content += `\n\nExtra instruction: ${instruction}`;
  return {
    model: POLISH_MODEL,
    max_tokens: 600,
    system,
    messages: [{ role: "user", content }],
  };
}

async function polishDraft(client, opts) {
  const msg = await client.messages.create(buildPolishRequest(opts));
  return (msg.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

module.exports = { buildPolishRequest, polishDraft, POLISH_MODEL };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/sender-polish.test.js`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/sender-polish.js tests/sender-polish.test.js
git commit -m "feat(sender): Haiku draft polishing in English or Arabic

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `sendTextDetailed` in wa.js

**Files:**
- Modify: `lib/wa.js` (add function after `sendText`, ~line 33; add to `module.exports` ~line 316)
- Test: `tests/wa-send-detailed.test.js`

**Interfaces:**
- Produces: `async sendTextDetailed(to, body) → { ok: true, id: string } | { ok: false, code: number|null, message: string }`. Existing `send()` / `sendText()` unchanged.

- [ ] **Step 1: Write the failing test** — `tests/wa-send-detailed.test.js`

```js
const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const wa = require("../lib/wa.js");

test("success returns the wamid", async (t) => {
  let posted;
  t.mock.method(axios, "post", async (url, payload) => {
    posted = payload;
    return { data: { messages: [{ id: "wamid.ABC" }] } };
  });
  const r = await wa.sendTextDetailed("97411111111", "Hello");
  assert.deepEqual(r, { ok: true, id: "wamid.ABC" });
  assert.equal(posted.type, "text");
  assert.equal(posted.to, "97411111111");
  assert.equal(posted.text.body, "Hello");
});

test("Graph error returns code + details", async (t) => {
  t.mock.method(axios, "post", async () => {
    const err = new Error("Request failed with status code 400");
    err.response = { data: { error: { code: 131030, message: "(#131030) Recipient phone number not in allowed list", error_data: { details: "Recipient phone number not in allowed list" } } } };
    throw err;
  });
  const r = await wa.sendTextDetailed("97411111111", "Hello");
  assert.equal(r.ok, false);
  assert.equal(r.code, 131030);
  assert.equal(r.message, "Recipient phone number not in allowed list");
});

test("network error has null code and the error message", async (t) => {
  t.mock.method(axios, "post", async () => { throw new Error("ECONNRESET"); });
  const r = await wa.sendTextDetailed("97411111111", "Hello");
  assert.deepEqual(r, { ok: false, code: null, message: "ECONNRESET" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/wa-send-detailed.test.js`
Expected: FAIL — `wa.sendTextDetailed is not a function`

- [ ] **Step 3: Implement** — in `lib/wa.js`, directly after the `sendText` function add:

```js
// Like sendText, but reports what the Graph API said instead of a bare
// boolean — the Bot Sender app needs the wamid (to poll delivery status)
// or the error code to show the user.
async function sendTextDetailed(to, body) {
  const payload = { messaging_product: "whatsapp", to, type: "text", text: { preview_url: true, body } };
  crm.logOutbound(to, payload);
  try {
    const res = await axios.post(GRAPH_URL, payload, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    });
    console.log(`✅ Sent text to ${to} (Bot Sender)`);
    return { ok: true, id: res.data?.messages?.[0]?.id };
  } catch (err) {
    const e = err.response?.data?.error;
    console.error("❌ Bot Sender send error:", err.response?.data || err.message);
    return { ok: false, code: e?.code ?? null, message: e?.error_data?.details || e?.message || err.message };
  }
}
```

and change the export line `send, sendText, sendLongText, ...` to include it:

```js
  send, sendText, sendTextDetailed, sendLongText, sendButtons, sendDocument, sendDriveFile, sendPdfBuffer,
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/wa-send-detailed.test.js tests/wa-builders.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/wa.js tests/wa-send-detailed.test.js
git commit -m "feat(wa): sendTextDetailed returns wamid or Graph error

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Sender API router

**Files:**
- Create: `lib/sender-api.js`
- Test: `tests/sender-api.test.js`

**Interfaces:**
- Consumes: `normalizeNumber` from `lib/accounts.js`; a status store shaped like Task 1 (`track`, `get`).
- Produces: `createSenderRouter({ pin, loadAccounts, polish, sendMessage, statusStore }) → express.Router`, where
  - `loadAccounts: () => Promise<Map<number, {number, name, paid}>>`
  - `polish: ({text, language, instruction}) => Promise<{ok:true, draft} | {ok:false, message}>`
  - `sendMessage: (to, text) => Promise<{ok:true, id} | {ok:false, code, message}>` (Task 3 shape)
- HTTP contract (the Android app depends on this exactly):
  - any route, no/empty `pin` → `503 {"error":"sender_disabled"}`; wrong header → `401 {"error":"bad_pin"}`
  - `GET /contacts` → `200 {"contacts":[{"number","name"}]}` sorted by name (number if blank); loader throws → `502 {"error":"sheet_unavailable","message"}`
  - `POST /polish {text, language, instruction?}` → `200 {"draft"}`; blank text → `400 {"error":"empty_text"}`; language not en/ar → `400 {"error":"bad_language"}`; polish not ok → `503 {"error":"ai_unavailable","message"}`
  - `POST /send {to, text}` → `200 {"ok":true,"id"}`; `<8` digits → `400 {"error":"bad_number"}`; blank → `400 {"error":"empty_text"}`; `>4096` chars → `400 {"error":"too_long"}`; Graph error → `502 {"ok":false,"code","message","outsideWindow"}`
  - `GET /status/:id` → `200 {"status", "code"?, "message"?, "outsideWindow"?}`; unknown → `404 {"status":"unknown"}`

- [ ] **Step 1: Write the failing test** — `tests/sender-api.test.js`

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/sender-api.test.js`
Expected: FAIL — `Cannot find module '../lib/sender-api.js'`

- [ ] **Step 3: Implement** — `lib/sender-api.js`

```js
// ============================================================
//  /api/sender — backend for the "Bot Sender" Android app, which
//  lets the owner message any number FROM the bot's WhatsApp
//  number. Anyone holding the PIN can speak as the bot, so every
//  route is locked behind X-Sender-Pin, and the whole router is
//  off unless SENDER_PIN is set.
//
//  Dependencies are injected so the router is testable without
//  Google Sheets, Anthropic or Meta.
// ============================================================
const express = require("express");
const crypto = require("node:crypto");
const { normalizeNumber } = require("./accounts.js");
const { OUTSIDE_WINDOW_CODE } = require("./sender-status.js");

const MAX_TEXT = 4096;
const MIN_DIGITS = 8;
const LANGUAGES = new Set(["en", "ar"]);

function pinMatches(expected, given) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(given || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSenderRouter({ pin, loadAccounts, polish, sendMessage, statusStore }) {
  const router = express.Router();
  router.use(express.json());

  router.use((req, res, next) => {
    if (!pin) return res.status(503).json({ error: "sender_disabled" });
    if (!pinMatches(pin, req.get("X-Sender-Pin"))) return res.status(401).json({ error: "bad_pin" });
    next();
  });

  router.get("/contacts", async (req, res) => {
    try {
      const accounts = await loadAccounts();
      const label = (c) => (c.name || c.number).toLowerCase();
      const contacts = [...accounts.values()]
        .map((a) => ({ number: a.number, name: a.name || "" }))
        .sort((x, y) => label(x).localeCompare(label(y)));
      res.json({ contacts });
    } catch (err) {
      res.status(502).json({ error: "sheet_unavailable", message: err.message });
    }
  });

  router.post("/polish", async (req, res) => {
    const text = String(req.body?.text ?? "").trim();
    const language = req.body?.language ?? "en";
    const instruction = String(req.body?.instruction ?? "").trim();
    if (!text) return res.status(400).json({ error: "empty_text" });
    if (!LANGUAGES.has(language)) return res.status(400).json({ error: "bad_language" });
    const result = await polish({ text, language, instruction });
    if (!result.ok) return res.status(503).json({ error: "ai_unavailable", message: result.message });
    res.json({ draft: result.draft });
  });

  router.post("/send", async (req, res) => {
    const to = normalizeNumber(req.body?.to);
    const text = String(req.body?.text ?? "");
    if (to.length < MIN_DIGITS) return res.status(400).json({ error: "bad_number" });
    if (!text.trim()) return res.status(400).json({ error: "empty_text" });
    if (text.length > MAX_TEXT) return res.status(400).json({ error: "too_long" });
    const r = await sendMessage(to, text);
    if (!r.ok) {
      return res.status(502).json({
        ok: false, code: r.code ?? null, message: r.message || "Send failed",
        outsideWindow: r.code === OUTSIDE_WINDOW_CODE,
      });
    }
    statusStore.track(r.id);
    res.json({ ok: true, id: r.id });
  });

  router.get("/status/:id", (req, res) => {
    const entry = statusStore.get(req.params.id);
    if (!entry) return res.status(404).json({ status: "unknown" });
    const { ts, ...rest } = entry;
    res.json(rest);
  });

  return router;
}

module.exports = { createSenderRouter };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/sender-api.test.js`
Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/sender-api.js tests/sender-api.test.js
git commit -m "feat(sender): PIN-protected /api/sender router

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire the router and webhook statuses into server.js

**Files:**
- Modify: `server.js` — requires near line 52 (`const wa = require("./lib/wa.js");`); new block immediately before `app.post("/webhook", ...)` (~line 2339); one line inside that handler.

**Interfaces:**
- Consumes: `createSenderRouter` (Task 4), `createStatusStore` (Task 1), `polishDraft` (Task 2), `wa.sendTextDetailed` (Task 3); existing `loadSheet`, `anthropic`, `ANTHROPIC_API_KEY`, `isExhausted`, `isCreditError`, `markExhausted`.

- [ ] **Step 1: Add requires** after `const wa = require("./lib/wa.js");`:

```js
const { createSenderRouter } = require("./lib/sender-api.js");
const { createStatusStore } = require("./lib/sender-status.js");
const { polishDraft } = require("./lib/sender-polish.js");
```

- [ ] **Step 2: Mount the router** — insert directly before `app.post("/webhook", (req, res) => {`:

```js
// ── Bot Sender app API ──────────────────────────────────────────────────────
// Lets the owner's Android app send messages as the bot. Off unless
// SENDER_PIN is set. Delivery results arrive via the webhook's `statuses`.
const senderStatus = createStatusStore();
app.use("/api/sender", createSenderRouter({
  pin: process.env.SENDER_PIN,
  loadAccounts: async () => (await loadSheet()).accounts,
  polish: async (opts) => {
    if (!ANTHROPIC_API_KEY) return { ok: false, message: "No Anthropic API key is configured on the server." };
    if (isExhausted()) return { ok: false, message: "AI credits are exhausted — top up the Anthropic balance." };
    try {
      return { ok: true, draft: await polishDraft(anthropic, opts) };
    } catch (err) {
      if (isCreditError(err)) markExhausted();
      console.error("Bot Sender polish error:", err.message);
      return { ok: false, message: err.message };
    }
  },
  sendMessage: wa.sendTextDetailed,
  statusStore: senderStatus,
}));
```

- [ ] **Step 3: Feed statuses** — in the webhook handler, change

```js
  const value = req.body.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  if (!message) return;
```

to

```js
  const value = req.body.entry?.[0]?.changes?.[0]?.value;
  for (const s of value?.statuses || []) senderStatus.record(s);
  const message = value?.messages?.[0];
  if (!message) return;
```

- [ ] **Step 4: Verify**

Run: `node --check server.js && npm test`
Expected: syntax OK; all test files pass (existing + 4 new). Router behaviour is covered by Task 4 tests; the wiring is verified live in Task 9 (starting server.js locally needs Google/Meta credentials).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(sender): mount /api/sender and record webhook statuses

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Android SDK + project scaffold + pure-Kotlin units

**Prerequisite — ask the user first (explicit yes required):** download Android command-line tools (`commandlinetools-win-11076708_latest.zip`, ~150 MB, from `https://dl.google.com/android/repository/`) and accept Android SDK licenses, then install `platform-tools`, `platforms;android-35`, `build-tools;35.0.0` (~250 MB).

**Files (all under `C:\Users\HP\OneDrive\Claude AI\WhatsAppSender`):**
- Create: `settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`, `local.properties`, `.gitignore`, `app/build.gradle.kts`, `app/proguard-rules.pro`, `app/src/main/AndroidManifest.xml`, `app/src/main/res/values/strings.xml`, `app/src/main/res/values/themes.xml`
- Create: `app/src/main/java/com/mannai/botsender/PhoneNumbers.kt`, `Recipient.kt`, `ApiModels.kt`
- Test: `app/src/test/java/com/mannai/botsender/PhoneNumbersTest.kt`, `RecipientListTest.kt`, `ErrorMapperTest.kt`

**Interfaces:**
- Produces:
  - `object PhoneNumbers { fun normalize(input: String): String? ; fun display(number: String): String }` — `normalize` returns digits-only or `null` if `< 8` digits; `display` returns `"+$number"`.
  - `data class Recipient(val number: String, val name: String = "", val favourite: Boolean = false) { val label: String }` — label = `"$name (+$number)"` or `"+$number"` when name blank.
  - `object RecipientList { fun merge(favourites: List<Recipient>, contacts: List<Recipient>): List<Recipient> }` — favourites first (flag `favourite=true`, keep their name unless blank → take contact's), then remaining contacts; dedupe by number.
  - `sealed interface ApiResult<out T> { data class Ok<T>(val value: T); data class Fail(val message: String, val code: Int? = null, val outsideWindow: Boolean = false) }`
  - `object ErrorMapper { fun fromHttp(httpCode: Int, body: String?): ApiResult.Fail ; const val NETWORK_MESSAGE }`
  - DTOs: `ContactDto`, `ContactsResponse`, `PolishRequest`, `PolishResponse`, `SendRequest`, `SendResponse`, `StatusResponse`, `ErrorBody`; `val ApiJson: Json`.

- [ ] **Step 1: Install SDK (after user yes)** — PowerShell:

```powershell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$zip = "$env:TEMP\cmdline-tools.zip"
Invoke-WebRequest "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip" -OutFile $zip
Expand-Archive $zip -DestinationPath "$sdk\cmdline-tools\_tmp" -Force
Move-Item "$sdk\cmdline-tools\_tmp\cmdline-tools" "$sdk\cmdline-tools\latest"
Remove-Item "$sdk\cmdline-tools\_tmp" -Recurse -Force
"y`ny`ny`ny`ny`ny`ny`ny`n" | & "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --licenses
& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" "platform-tools" "platforms;android-35" "build-tools;35.0.0"
```

Expected: `$sdk\platforms\android-35` and `$sdk\build-tools\35.0.0` exist.

- [ ] **Step 2: Scaffold Gradle files**

`settings.gradle.kts`:
```kotlin
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "WhatsAppSender"
include(":app")
```

`build.gradle.kts`:
```kotlin
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21" apply false
}
```

`gradle.properties`:
```properties
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
android.nonTransitiveRClass=true
```

`local.properties` (gitignored):
```properties
sdk.dir=C\:\\Users\\HP\\AppData\\Local\\Android\\Sdk
```

`.gitignore`:
```
.gradle/
build/
local.properties
.idea/
*.iml
captures/
```

`app/build.gradle.kts`:
```kotlin
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.mannai.botsender"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.mannai.botsender"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }
    buildTypes {
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    testImplementation("junit:junit:4.13.2")
}
```

`app/proguard-rules.pro`: empty file.

`app/src/main/AndroidManifest.xml`:
```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:label="@string/app_name"
        android:icon="@android:drawable/sym_action_chat"
        android:supportsRtl="true"
        android:theme="@style/Theme.BotSender">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

`app/src/main/res/values/strings.xml`:
```xml
<resources>
    <string name="app_name">Bot Sender</string>
</resources>
```

`app/src/main/res/values/themes.xml`:
```xml
<resources>
    <style name="Theme.BotSender" parent="android:Theme.Material.Light.NoActionBar" />
</resources>
```

Generate the wrapper with the cached Gradle 8.10.2 (bash):
```bash
cd "/c/Users/HP/OneDrive/Claude AI/WhatsAppSender"
GRADLE=$(ls -d ~/.gradle/wrapper/dists/gradle-8.10.2-bin/*/gradle-8.10.2/bin/gradle | head -1)
"$GRADLE" wrapper --gradle-version 8.10.2
git init -q
```

- [ ] **Step 3: Write failing tests**

`app/src/test/java/com/mannai/botsender/PhoneNumbersTest.kt`:
```kotlin
package com.mannai.botsender

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhoneNumbersTest {
    @Test fun stripsEverythingButDigits() {
        assertEquals("97412345678", PhoneNumbers.normalize("+974 1234-5678"))
        assertEquals("97412345678", PhoneNumbers.normalize(" (974) 12345678 "))
    }
    @Test fun tooShortIsNull() {
        assertNull(PhoneNumbers.normalize("+974 123"))
        assertNull(PhoneNumbers.normalize(""))
    }
    @Test fun displayAddsPlus() {
        assertEquals("+97412345678", PhoneNumbers.display("97412345678"))
    }
}
```

`app/src/test/java/com/mannai/botsender/RecipientListTest.kt`:
```kotlin
package com.mannai.botsender

import org.junit.Assert.assertEquals
import org.junit.Test

class RecipientListTest {
    @Test fun favouritesFirstThenContactsWithoutDuplicates() {
        val favs = listOf(Recipient("97422222222", "Zed"))
        val contacts = listOf(Recipient("97411111111", "Ahmed"), Recipient("97422222222", "Zed Sheet"))
        val merged = RecipientList.merge(favs, contacts)
        assertEquals(listOf("97422222222", "97411111111"), merged.map { it.number })
        assertEquals(true, merged[0].favourite)
        assertEquals("Zed", merged[0].name)
        assertEquals(false, merged[1].favourite)
    }
    @Test fun blankFavouriteNameBorrowsContactName() {
        val merged = RecipientList.merge(listOf(Recipient("97411111111")), listOf(Recipient("97411111111", "Ahmed")))
        assertEquals("Ahmed", merged.single().name)
        assertEquals(true, merged.single().favourite)
    }
    @Test fun labelFormats() {
        assertEquals("Ahmed (+97411111111)", Recipient("97411111111", "Ahmed").label)
        assertEquals("+97411111111", Recipient("97411111111").label)
    }
}
```

`app/src/test/java/com/mannai/botsender/ErrorMapperTest.kt`:
```kotlin
package com.mannai.botsender

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ErrorMapperTest {
    @Test fun badPin() {
        assertEquals("PIN rejected — check Settings", ErrorMapper.fromHttp(401, """{"error":"bad_pin"}""").message)
    }
    @Test fun senderDisabled() {
        assertEquals(
            "Sender is switched off on the server (SENDER_PIN not set on Render)",
            ErrorMapper.fromHttp(503, """{"error":"sender_disabled"}""").message,
        )
    }
    @Test fun aiUnavailable() {
        assertEquals(
            "AI polishing unavailable: credits exhausted",
            ErrorMapper.fromHttp(503, """{"error":"ai_unavailable","message":"credits exhausted"}""").message,
        )
    }
    @Test fun outsideWindowKeepsFlag() {
        val f = ErrorMapper.fromHttp(502, """{"ok":false,"code":131047,"message":"Re-engagement","outsideWindow":true}""")
        assertTrue(f.outsideWindow)
        assertEquals(131047, f.code)
    }
    @Test fun otherGraphError() {
        assertEquals(
            "WhatsApp rejected the message: Recipient not in allowed list (code 131030)",
            ErrorMapper.fromHttp(502, """{"ok":false,"code":131030,"message":"Recipient not in allowed list","outsideWindow":false}""").message,
        )
    }
    @Test fun validationErrors() {
        assertEquals("That phone number looks too short", ErrorMapper.fromHttp(400, """{"error":"bad_number"}""").message)
        assertEquals("Message is empty", ErrorMapper.fromHttp(400, """{"error":"empty_text"}""").message)
        assertEquals("Message is longer than WhatsApp's 4096-character limit", ErrorMapper.fromHttp(400, """{"error":"too_long"}""").message)
    }
    @Test fun garbageBody() {
        assertEquals("Server error (HTTP 500)", ErrorMapper.fromHttp(500, "<html>oops</html>").message)
    }
}
```

- [ ] **Step 4: Run to verify they fail**

Run (bash, in WhatsAppSender): `./gradlew testDebugUnitTest`
Expected: FAIL — compilation errors, `Unresolved reference: PhoneNumbers` etc.

- [ ] **Step 5: Implement**

`app/src/main/java/com/mannai/botsender/PhoneNumbers.kt`:
```kotlin
package com.mannai.botsender

/** Same rule as the bot's server (lib/accounts.js): digits only. */
object PhoneNumbers {
    private const val MIN_DIGITS = 8

    fun normalize(input: String): String? {
        val digits = input.filter { it.isDigit() }
        return if (digits.length >= MIN_DIGITS) digits else null
    }

    fun display(number: String): String = "+$number"
}
```

`app/src/main/java/com/mannai/botsender/Recipient.kt`:
```kotlin
package com.mannai.botsender

data class Recipient(
    val number: String,
    val name: String = "",
    val favourite: Boolean = false,
) {
    val label: String
        get() = if (name.isBlank()) PhoneNumbers.display(number) else "$name (${PhoneNumbers.display(number)})"
}

object RecipientList {
    /** Favourites first, then the Allowed-tab contacts not already listed. */
    fun merge(favourites: List<Recipient>, contacts: List<Recipient>): List<Recipient> {
        val byNumber = contacts.associateBy { it.number }
        val favs = favourites.map { fav ->
            val name = fav.name.ifBlank { byNumber[fav.number]?.name.orEmpty() }
            fav.copy(name = name, favourite = true)
        }
        val favNumbers = favs.map { it.number }.toSet()
        return favs + contacts.filter { it.number !in favNumbers }.map { it.copy(favourite = false) }
    }
}
```

`app/src/main/java/com/mannai/botsender/ApiModels.kt`:
```kotlin
package com.mannai.botsender

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

val ApiJson = Json { ignoreUnknownKeys = true; encodeDefaults = true }

@Serializable data class ContactDto(val number: String, val name: String = "")
@Serializable data class ContactsResponse(val contacts: List<ContactDto> = emptyList())
@Serializable data class PolishRequest(val text: String, val language: String, val instruction: String = "")
@Serializable data class PolishResponse(val draft: String)
@Serializable data class SendRequest(val to: String, val text: String)
@Serializable data class SendResponse(val ok: Boolean = false, val id: String? = null)
@Serializable data class StatusResponse(
    val status: String,
    val code: Int? = null,
    val message: String? = null,
    val outsideWindow: Boolean = false,
)
@Serializable data class ErrorBody(
    val error: String? = null,
    val message: String? = null,
    val code: Int? = null,
    val outsideWindow: Boolean = false,
)

sealed interface ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>
    data class Fail(val message: String, val code: Int? = null, val outsideWindow: Boolean = false) : ApiResult<Nothing>
}

object ErrorMapper {
    const val NETWORK_MESSAGE = "Server not reachable (Render may be waking up) — try again"

    fun fromHttp(httpCode: Int, body: String?): ApiResult.Fail {
        val err = runCatching { ApiJson.decodeFromString<ErrorBody>(body.orEmpty()) }.getOrNull()
        return when {
            httpCode == 401 -> ApiResult.Fail("PIN rejected — check Settings")
            err?.error == "sender_disabled" -> ApiResult.Fail("Sender is switched off on the server (SENDER_PIN not set on Render)")
            err?.error == "ai_unavailable" -> ApiResult.Fail("AI polishing unavailable: ${err.message.orEmpty()}")
            err?.error == "sheet_unavailable" -> ApiResult.Fail("Couldn't read the Allowed tab: ${err.message.orEmpty()}")
            err?.error == "bad_number" -> ApiResult.Fail("That phone number looks too short")
            err?.error == "empty_text" -> ApiResult.Fail("Message is empty")
            err?.error == "too_long" -> ApiResult.Fail("Message is longer than WhatsApp's 4096-character limit")
            err?.error == "bad_language" -> ApiResult.Fail("Unsupported language")
            err?.outsideWindow == true -> ApiResult.Fail(err.message.orEmpty(), err.code, outsideWindow = true)
            httpCode == 502 && err?.message != null ->
                ApiResult.Fail("WhatsApp rejected the message: ${err.message} (code ${err.code})", err.code)
            else -> ApiResult.Fail("Server error (HTTP $httpCode)")
        }
    }
}
```

- [ ] **Step 6: Run to verify they pass**

Run: `./gradlew testDebugUnitTest`
Expected: BUILD SUCCESSFUL, 13 tests pass.

- [ ] **Step 7: Commit** (in WhatsAppSender)

```bash
git add .gitignore settings.gradle.kts build.gradle.kts gradle.properties gradlew gradlew.bat gradle app
git commit -m "feat: scaffold Bot Sender app with number, recipient and error units

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: HTTP client + local stores

**Files:**
- Create: `app/src/main/java/com/mannai/botsender/SenderApi.kt`, `Stores.kt`

**Interfaces:**
- Consumes: DTOs, `ApiResult`, `ErrorMapper`, `ApiJson`, `Recipient` (Task 6).
- Produces:
  - `class SenderApi(baseUrl: String, pin: String, client: OkHttpClient = SenderApi.defaultClient)` with suspend funs `contacts(): ApiResult<List<Recipient>>`, `polish(text: String, language: String, instruction: String): ApiResult<String>`, `send(to: String, text: String): ApiResult<String>` (wamid), `status(id: String): ApiResult<StatusResponse>`.
  - `class SettingsStore(context: Context) { var baseUrl: String; var pin: String; val isConfigured: Boolean }`
  - `class FavouritesStore(context: Context) { fun load(): List<Recipient>; fun save(list: List<Recipient>) }`

- [ ] **Step 1: Implement** — `SenderApi.kt`

```kotlin
package com.mannai.botsender

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class SenderApi(
    baseUrl: String,
    private val pin: String,
    private val client: OkHttpClient = defaultClient,
) {
    private val root = baseUrl.trim().trimEnd('/') + "/api/sender"

    suspend fun contacts(): ApiResult<List<Recipient>> =
        call(get("/contacts")) { body ->
            ApiJson.decodeFromString<ContactsResponse>(body).contacts.map { Recipient(it.number, it.name) }
        }

    suspend fun polish(text: String, language: String, instruction: String): ApiResult<String> =
        call(post("/polish", ApiJson.encodeToString(PolishRequest(text, language, instruction)))) { body ->
            ApiJson.decodeFromString<PolishResponse>(body).draft
        }

    suspend fun send(to: String, text: String): ApiResult<String> =
        call(post("/send", ApiJson.encodeToString(SendRequest(to, text)))) { body ->
            ApiJson.decodeFromString<SendResponse>(body).id.orEmpty()
        }

    suspend fun status(id: String): ApiResult<StatusResponse> =
        call(get("/status/$id"), okCodes = setOf(200, 404)) { body ->
            ApiJson.decodeFromString<StatusResponse>(body)
        }

    private fun get(path: String) = Request.Builder().url(root + path).header(PIN_HEADER, pin).get().build()

    private fun post(path: String, json: String) = Request.Builder().url(root + path).header(PIN_HEADER, pin)
        .post(json.toRequestBody(JSON_TYPE)).build()

    private suspend fun <T> call(
        request: Request,
        okCodes: Set<Int> = setOf(200),
        parse: (String) -> T,
    ): ApiResult<T> = withContext(Dispatchers.IO) {
        try {
            client.newCall(request).execute().use { res ->
                val body = res.body?.string().orEmpty()
                if (res.code in okCodes) {
                    runCatching { ApiResult.Ok(parse(body)) }
                        .getOrElse { ApiResult.Fail("Unexpected reply from server") }
                } else {
                    ErrorMapper.fromHttp(res.code, body)
                }
            }
        } catch (e: IOException) {
            ApiResult.Fail(ErrorMapper.NETWORK_MESSAGE)
        } catch (e: IllegalArgumentException) {
            ApiResult.Fail("Server URL is not valid — check Settings")
        }
    }

    companion object {
        private const val PIN_HEADER = "X-Sender-Pin"
        private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()

        // Render's free tier can take ~50 s to wake up.
        val defaultClient: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(70, TimeUnit.SECONDS)
            .build()
    }
}
```

- [ ] **Step 2: Implement** — `Stores.kt`

```kotlin
package com.mannai.botsender

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.encodeToString

/** Server URL + PIN, encrypted at rest. */
class SettingsStore(context: Context) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "settings",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    var baseUrl: String
        get() = prefs.getString("baseUrl", "").orEmpty()
        set(v) = prefs.edit().putString("baseUrl", v.trim()).apply()

    var pin: String
        get() = prefs.getString("pin", "").orEmpty()
        set(v) = prefs.edit().putString("pin", v).apply()

    val isConfigured: Boolean get() = baseUrl.isNotBlank() && pin.isNotBlank()
}

/** Favourite numbers kept on the phone only. */
class FavouritesStore(context: Context) {
    private val prefs = context.getSharedPreferences("favourites", Context.MODE_PRIVATE)

    fun load(): List<Recipient> =
        runCatching {
            ApiJson.decodeFromString<List<ContactDto>>(prefs.getString("list", "[]").orEmpty())
                .map { Recipient(it.number, it.name, favourite = true) }
        }.getOrDefault(emptyList())

    fun save(list: List<Recipient>) {
        val json = ApiJson.encodeToString(list.map { ContactDto(it.number, it.name) })
        prefs.edit().putString("list", json).apply()
    }
}
```

- [ ] **Step 3: Verify it compiles and tests still pass**

Run: `./gradlew testDebugUnitTest`
Expected: BUILD SUCCESSFUL, 13 tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/main/java/com/mannai/botsender/SenderApi.kt app/src/main/java/com/mannai/botsender/Stores.kt
git commit -m "feat: OkHttp client for /api/sender and local settings/favourites stores

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: ViewModel, screens, APK

**Files:**
- Create: `app/src/main/java/com/mannai/botsender/ComposeViewModel.kt`, `MainActivity.kt`, `ui/SetupScreen.kt`, `ui/ComposeScreen.kt`

**Interfaces:**
- Consumes: `SenderApi`, `SettingsStore`, `FavouritesStore`, `RecipientList`, `PhoneNumbers`, `ApiResult` (Tasks 6–7).
- Produces: `ComposeViewModel(app: Application)` with `val state: StateFlow<UiState>` and actions `saveSettings(url, pin)`, `openSettings()`, `closeSettings()`, `refreshContacts()`, `selectRecipient(r)`, `setTypedNumber(s)`, `setUseTyped(b)`, `toggleFavourite()`, `setMessage(s)`, `setLanguage(l)`, `setInstruction(s)`, `polish()`, `undoPolish()`, `requestSend()`, `cancelSend()`, `confirmSend()`, `dismissBanner()`.

- [ ] **Step 1: Implement** — `ComposeViewModel.kt`

```kotlin
package com.mannai.botsender

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class Busy { None, Loading, Polishing, Sending }

data class Banner(val kind: Kind, val text: String) {
    enum class Kind { Success, Warning, Error }
}

data class UiState(
    val showSettings: Boolean = false,
    val baseUrl: String = "",
    val recipients: List<Recipient> = emptyList(),
    val selected: Recipient? = null,
    val useTyped: Boolean = false,
    val typedNumber: String = "",
    val message: String = "",
    val beforePolish: String? = null,
    val language: String = "en",
    val instruction: String = "",
    val busy: Busy = Busy.None,
    val banner: Banner? = null,
    val confirmTarget: Recipient? = null,
) {
    /** Who "Send" would go to right now, or null if nothing valid is chosen. */
    val target: Recipient?
        get() = if (useTyped) {
            PhoneNumbers.normalize(typedNumber)?.let { n -> recipients.firstOrNull { it.number == n } ?: Recipient(n) }
        } else selected
}

class ComposeViewModel(app: Application) : AndroidViewModel(app) {
    private val settings = SettingsStore(app)
    private val favourites = FavouritesStore(app)
    private var contacts: List<Recipient> = emptyList()

    private val _state = MutableStateFlow(UiState(showSettings = !settings.isConfigured, baseUrl = settings.baseUrl))
    val state: StateFlow<UiState> = _state

    init { if (settings.isConfigured) refreshContacts() }

    private fun api() = SenderApi(settings.baseUrl, settings.pin)

    private fun rebuildList() = _state.update { s ->
        val list = RecipientList.merge(favourites.load(), contacts)
        s.copy(recipients = list, selected = s.selected?.let { sel -> list.firstOrNull { it.number == sel.number } })
    }

    fun saveSettings(url: String, pin: String) = viewModelScope.launch {
        _state.update { it.copy(busy = Busy.Loading, banner = null) }
        when (val r = SenderApi(url, pin).contacts()) {
            is ApiResult.Ok -> {
                settings.baseUrl = url; settings.pin = pin
                contacts = r.value
                _state.update { it.copy(busy = Busy.None, showSettings = false, baseUrl = url) }
                rebuildList()
            }
            is ApiResult.Fail -> _state.update { it.copy(busy = Busy.None, banner = Banner(Banner.Kind.Error, r.message)) }
        }
    }

    fun openSettings() = _state.update { it.copy(showSettings = true, banner = null) }
    fun closeSettings() { if (settings.isConfigured) _state.update { it.copy(showSettings = false, banner = null) } }

    fun refreshContacts() = viewModelScope.launch {
        _state.update { it.copy(busy = Busy.Loading) }
        when (val r = api().contacts()) {
            is ApiResult.Ok -> { contacts = r.value; _state.update { it.copy(busy = Busy.None) } }
            is ApiResult.Fail -> _state.update { it.copy(busy = Busy.None, banner = Banner(Banner.Kind.Error, r.message)) }
        }
        rebuildList()
    }

    fun selectRecipient(r: Recipient) = _state.update { it.copy(selected = r, useTyped = false) }
    fun setTypedNumber(s: String) = _state.update { it.copy(typedNumber = s) }
    fun setUseTyped(b: Boolean) = _state.update { it.copy(useTyped = b) }

    fun toggleFavourite() {
        val target = _state.value.target ?: return
        val current = favourites.load()
        val next = if (current.any { it.number == target.number }) current.filterNot { it.number == target.number }
                   else current + target.copy(favourite = true)
        favourites.save(next)
        rebuildList()
    }

    fun setMessage(s: String) = _state.update { it.copy(message = s) }
    fun setLanguage(l: String) = _state.update { it.copy(language = l) }
    fun setInstruction(s: String) = _state.update { it.copy(instruction = s) }

    fun polish() = viewModelScope.launch {
        val s = _state.value
        if (s.message.isBlank()) return@launch
        _state.update { it.copy(busy = Busy.Polishing, banner = null) }
        when (val r = api().polish(s.message, s.language, s.instruction)) {
            is ApiResult.Ok -> _state.update {
                it.copy(busy = Busy.None, beforePolish = it.beforePolish ?: s.message, message = r.value, instruction = "")
            }
            is ApiResult.Fail -> _state.update { it.copy(busy = Busy.None, banner = Banner(Banner.Kind.Error, r.message)) }
        }
    }

    fun undoPolish() = _state.update { s -> s.beforePolish?.let { s.copy(message = it, beforePolish = null) } ?: s }

    fun requestSend() {
        val s = _state.value
        val target = s.target
        when {
            target == null -> _state.update { it.copy(banner = Banner(Banner.Kind.Error, "Choose a contact or type a valid number")) }
            s.message.isBlank() -> _state.update { it.copy(banner = Banner(Banner.Kind.Error, "Message is empty")) }
            else -> _state.update { it.copy(confirmTarget = target, banner = null) }
        }
    }

    fun cancelSend() = _state.update { it.copy(confirmTarget = null) }

    fun confirmSend() = viewModelScope.launch {
        val target = _state.value.confirmTarget ?: return@launch
        val text = _state.value.message
        _state.update { it.copy(confirmTarget = null, busy = Busy.Sending, banner = null) }
        val api = api()
        when (val r = api.send(target.number, text)) {
            is ApiResult.Fail -> finish(target, r.message, r.outsideWindow)
            is ApiResult.Ok -> pollStatus(api, target, r.value)
        }
    }

    private suspend fun pollStatus(api: SenderApi, target: Recipient, id: String) {
        var last = "pending"
        repeat(MAX_POLLS) {
            delay(POLL_MS)
            val r = api.status(id)
            if (r is ApiResult.Ok) {
                last = r.value.status
                when (last) {
                    "failed" -> return finish(target, r.value.message ?: "Delivery failed", r.value.outsideWindow, r.value.code)
                    "delivered", "read" -> return succeed(target, "✅ Delivered to ${target.label}")
                }
            }
        }
        succeed(target, if (last == "sent") "✅ Sent to ${target.label} (not yet delivered)" else "✅ Sent to ${target.label}")
    }

    private fun succeed(target: Recipient, text: String) = _state.update {
        it.copy(busy = Busy.None, banner = Banner(Banner.Kind.Success, text), message = "", beforePolish = null)
    }

    private fun finish(target: Recipient, message: String, outsideWindow: Boolean, code: Int? = null) = _state.update {
        val banner = if (outsideWindow) Banner(
            Banner.Kind.Warning,
            "⚠️ ${target.label} hasn't messaged the bot in the last 24 h. WhatsApp only allows a template message. " +
                "Ask them to send 'hi' to the bot first.",
        ) else Banner(Banner.Kind.Error, "❌ " + if (code != null && !message.contains("code")) "$message (code $code)" else message)
        it.copy(busy = Busy.None, banner = banner)
    }

    fun dismissBanner() = _state.update { it.copy(banner = null) }

    companion object {
        private const val POLL_MS = 1500L
        private const val MAX_POLLS = 10
    }
}
```

- [ ] **Step 2: Implement** — `ui/SetupScreen.kt`

```kotlin
package com.mannai.botsender.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.mannai.botsender.Busy
import com.mannai.botsender.UiState

@Composable
fun SetupScreen(state: UiState, onSave: (String, String) -> Unit, onCancel: (() -> Unit)?) {
    var url by remember { mutableStateOf(state.baseUrl.ifBlank { "https://" }) }
    var pin by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Server settings", style = MaterialTheme.typography.headlineSmall)
        Text("Your bot's Render address and the SENDER_PIN set on Render.")
        OutlinedTextField(
            value = url, onValueChange = { url = it }, label = { Text("Server URL") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = pin, onValueChange = { pin = it }, label = { Text("PIN") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth(),
        )
        state.banner?.let { Text(it.text, color = MaterialTheme.colorScheme.error) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { onSave(url, pin) },
                enabled = state.busy == Busy.None && url.length > 8 && pin.isNotBlank(),
            ) { Text(if (state.busy == Busy.Loading) "Testing…" else "Test & save") }
            onCancel?.let { OutlinedButton(onClick = it) { Text("Cancel") } }
        }
        if (state.busy == Busy.Loading) Text("First call can take up to a minute while Render wakes up.")
    }
}
```

- [ ] **Step 3: Implement** — `ui/ComposeScreen.kt`

```kotlin
package com.mannai.botsender.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.mannai.botsender.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComposeScreen(state: UiState, vm: ComposeViewModel) {
    val idle = state.busy == Busy.None
    Scaffold(topBar = {
        TopAppBar(title = { Text("Bot Sender") }, actions = {
            IconButton(onClick = vm::refreshContacts, enabled = idle) { Icon(Icons.Default.Refresh, "Reload contacts") }
            IconButton(onClick = vm::openSettings) { Icon(Icons.Default.Settings, "Settings") }
        })
    }) { pad ->
        Column(
            Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // ── Recipient ──
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                FilterChip(selected = !state.useTyped, onClick = { vm.setUseTyped(false) }, label = { Text("Select") })
                Spacer(Modifier.width(8.dp))
                FilterChip(selected = state.useTyped, onClick = { vm.setUseTyped(true) }, label = { Text("Type number") })
                Spacer(Modifier.weight(1f))
                val isFav = state.target?.let { t -> state.recipients.any { it.number == t.number && it.favourite } } == true
                IconButton(onClick = vm::toggleFavourite, enabled = state.target != null) {
                    Icon(Icons.Default.Star, "Favourite", tint = if (isFav) Color(0xFFF5B400) else Color.Gray)
                }
            }
            if (state.useTyped) {
                OutlinedTextField(
                    value = state.typedNumber, onValueChange = vm::setTypedNumber,
                    label = { Text("Phone number with country code") }, placeholder = { Text("+974 5555 1234") },
                    singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                var open by remember { mutableStateOf(false) }
                ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }) {
                    OutlinedTextField(
                        value = state.selected?.label ?: "", onValueChange = {}, readOnly = true,
                        label = { Text("Contact") },
                        placeholder = { Text(if (state.busy == Busy.Loading) "Loading…" else "Choose") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(open) },
                        modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
                    )
                    ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                        state.recipients.forEach { r ->
                            DropdownMenuItem(
                                text = { Text((if (r.favourite) "⭐ " else "") + r.label) },
                                onClick = { vm.selectRecipient(r); open = false },
                            )
                        }
                    }
                }
            }

            // ── Message ──
            OutlinedTextField(
                value = state.message, onValueChange = vm::setMessage, label = { Text("Message") },
                minLines = 5, modifier = Modifier.fillMaxWidth(),
            )
            Text("${state.message.length} / 4096", style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = state.language == "en", onClick = { vm.setLanguage("en") }, label = { Text("EN") })
                FilterChip(selected = state.language == "ar", onClick = { vm.setLanguage("ar") }, label = { Text("عربي") })
            }
            OutlinedTextField(
                value = state.instruction, onValueChange = vm::setInstruction,
                label = { Text("Redraft instruction (optional)") }, placeholder = { Text("shorter, more formal…") },
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = vm::polish, enabled = idle && state.message.isNotBlank()) {
                    Text(if (state.busy == Busy.Polishing) "Polishing…" else "Polish with AI")
                }
                if (state.beforePolish != null) TextButton(onClick = vm::undoPolish, enabled = idle) { Text("Undo") }
            }

            // ── Result ──
            state.banner?.let { b ->
                val color = when (b.kind) {
                    Banner.Kind.Success -> Color(0xFF1B7F3B)
                    Banner.Kind.Warning -> Color(0xFFB26A00)
                    Banner.Kind.Error -> MaterialTheme.colorScheme.error
                }
                Card(onClick = vm::dismissBanner) { Text(b.text, color = color, modifier = Modifier.padding(12.dp)) }
            }

            Button(onClick = vm::requestSend, enabled = idle, modifier = Modifier.fillMaxWidth()) {
                Text(if (state.busy == Busy.Sending) "Sending…" else "Send as bot")
            }
        }
    }

    state.confirmTarget?.let { t ->
        AlertDialog(
            onDismissRequest = vm::cancelSend,
            title = { Text("Send message?") },
            text = { Text("Send to ${t.label} from the bot's WhatsApp number?") },
            confirmButton = { TextButton(onClick = vm::confirmSend) { Text("Send") } },
            dismissButton = { TextButton(onClick = vm::cancelSend) { Text("Cancel") } },
        )
    }
}
```

- [ ] **Step 4: Implement** — `MainActivity.kt`

```kotlin
package com.mannai.botsender

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.mannai.botsender.ui.ComposeScreen
import com.mannai.botsender.ui.SetupScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme {
                Surface {
                    val vm: ComposeViewModel = viewModel()
                    val state by vm.state.collectAsStateWithLifecycle()
                    if (state.showSettings) {
                        SetupScreen(
                            state = state,
                            onSave = { url, pin -> vm.saveSettings(url, pin) },
                            onCancel = if (state.baseUrl.isNotBlank()) vm::closeSettings else null,
                        )
                    } else {
                        ComposeScreen(state, vm)
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 5: Build**

Run: `./gradlew testDebugUnitTest assembleDebug`
Expected: BUILD SUCCESSFUL; `app/build/outputs/apk/debug/app-debug.apk` exists. Fix any compile errors (e.g. `MenuAnchorType` requires material3 ≥ 1.3 — BOM 2024.12.01 provides 1.3.1) before continuing.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/java
git commit -m "feat: compose screen with contact picker, AI polish, send and status polling

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Deploy and end-to-end check

- [ ] **Step 1: Ask the user** to (a) choose a PIN and add `SENDER_PIN` to both Render services running this code, and (b) approve pushing WhatsAppBot `main` (auto-deploys to Render).
- [ ] **Step 2: Push** (after yes): `git push origin main`; wait for Render deploy.
- [ ] **Step 3: Probe auth** — `curl -s -o /dev/null -w "%{http_code}" https://<service>/api/sender/contacts` → expect `401` (PIN set) — `503` means the env var is missing.
- [ ] **Step 4: Hand over the APK** — send `app-debug.apk` to the user (SendUserFile); they enable "Install unknown apps", install, enter URL + PIN.
- [ ] **Step 5: E2E** — user messages the bot "hi" from their own phone, then sends a polished Arabic and an English message to themselves from the app; expect ✅ Delivered. Then send to a number that hasn't messaged in 24 h; expect the ⚠️ outside-window banner.
