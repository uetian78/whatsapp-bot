# WhatsApp Bot Architecture & UX Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break the 2,655-line `server.js` monolith into focused modules, unify the 8 ad-hoc per-user state stores into one session manager, remove the router/CRM-classifier duplication, and upgrade the WhatsApp UX (typing indicators, interactive list messages, cached media, consistent cancel/timeout behavior) — without changing any product-selection logic.

**Architecture:** Incremental extraction: new `lib/` modules are created with tests first, then `server.js` switches to importing them, verbatim-moving code rather than rewriting it. The webhook if-chain stays in `server.js` (it is the routing spec), but its intent predicates move to a shared `intents.js` consumed by both the router and `crm.classify()`. All state stays in-memory (single Render instance).

**Tech Stack:** Node 18+ CommonJS, Express, `node:test` (built-in — no new dependencies), WhatsApp Cloud API v21.0, googleapis, @anthropic-ai/sdk.

## Global Constraints

- **Never run `git add -A` or `git add .`** — the repo root contains untracked credential files (`_temp_sa.json`, `whatsapp-bot-498411-*.json`, `.env`). Always `git add` named files only.
- **Do not modify files under `vrf/` or `vrf-sidecar/`** except the documented touch points in `server.js` (`initVrf`, `vrfSessions`, `isVrfTrigger`). The VRF engine intentionally mirrors an upstream project.
- **Do not change any selection/engine logic** (`products.js`, `chillers.js`, `split-engine.js`, `mtz-engine.js`, `schedule-select.js`, `product-facts.js`, `catalogue-map.js`, `brand-docs.js`) — this plan only moves routing/transport/state code.
- No new npm dependencies. Tests use Node's built-in `node:test` + `node:assert`.
- WhatsApp API limits (enforce in builders): reply buttons max 3, titles ≤ 20 chars; list messages max 10 rows, row title ≤ 24 chars, row description ≤ 72 chars, button label ≤ 20 chars; interactive body ≤ 1024 chars (buttons) / 4096 (list); plain text ≤ 4096 chars.
- Vision/image extraction stays on Sonnet; text-only helpers stay on Haiku (`claude-haiku-4-5-20251001`). This plan adds no new AI calls.
- All moved code is moved **verbatim** — same function bodies, same log strings — unless a task explicitly shows a change.
- `server.js` remains the entrypoint (`npm start` unchanged).
- After every task: run `npm test`, then `node --check server.js` (plus `node --check` on any file you created/edited) as a syntax smoke test before committing.

---

## File Structure (end state)

```
server.js               — entrypoint: env check, express wiring, webhook router (thin)
intents.js              — NEW: ordered intent predicates shared by router + CRM
menu.js                 — welcome menu (gains list-message builder)
crm.js                  — CRM logging (classify() delegates to intents.js)
lib/
  google.js             — NEW: SA auth, token minting, sheets/drive clients, downloadBytes
  drive-index.js        — NEW: recursive Drive file index + doc-type/file matchers
  wa.js                 — NEW: all WhatsApp Graph send/upload/typing/list helpers + media-ID cache
  session-store.js      — NEW: unified per-user flow + context state with TTL
  user-queue.js         — NEW: per-user serialization of message handling
  (existing: drive-scan.js, find-files-by-name.js, related-files.js — untouched)
tests/
  menu.test.js          — NEW
  session-store.test.js — NEW
  intents.test.js       — NEW
  wa-builders.test.js   — NEW
  user-queue.test.js    — NEW
```

---

### Task 1: Test harness + first regression test

**Files:**
- Modify: `package.json`
- Test: `tests/menu.test.js`

**Interfaces:**
- Produces: `npm test` runs all `tests/*.test.js` via `node --test`. Later tasks add test files to the same directory.

- [ ] **Step 1: Add the test script**

In `package.json`, change the `scripts` block to:

```json
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "test": "node --test tests/"
  },
```

- [ ] **Step 2: Write the failing test**

Create `tests/menu.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { isMenuTrigger, smallTalkReply, welcomeMenu, tipFor, MENU_OPTIONS } = require("../menu.js");

test("isMenuTrigger matches whole-message greetings only", () => {
  assert.equal(isMenuTrigger("hi"), true);
  assert.equal(isMenuTrigger("Menu"), true);
  assert.equal(isMenuTrigger("good morning"), true);
  assert.equal(isMenuTrigger("salam"), true);
  assert.equal(isMenuTrigger("hi can I get the APMR catalogue"), false);
  assert.equal(isMenuTrigger("catalogue"), false);
});

test("smallTalkReply catches closings but not requests", () => {
  assert.ok(smallTalkReply("thanks"));
  assert.ok(smallTalkReply("bye"));
  assert.ok(smallTalkReply("ok"));
  assert.equal(smallTalkReply("thanks, now send the APMR IOM"), null);
});

test("welcomeMenu lists every option and tipFor resolves each", () => {
  const m = welcomeMenu("Hassan", true);
  assert.match(m.text, /Welcome back, Hassan/);
  for (const o of MENU_OPTIONS) {
    assert.match(m.text, new RegExp(o.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(tipFor(o.n), `tip missing for option ${o.n}`);
  }
  assert.equal(tipFor(99), null);
});
```

- [ ] **Step 3: Run tests to verify they run and pass**

Run: `npm test`
Expected: 3 passing tests, exit code 0. (These assert current behavior — if any fails, the test is wrong, not menu.js; fix the test.)

- [ ] **Step 4: Commit**

```bash
git add package.json tests/menu.test.js
git commit -m "test: add node:test harness with menu regression tests"
```

---

### Task 2: Startup env validation + crash reply to user

Right now a missing env var surfaces as a confusing runtime error mid-request, and an exception inside the webhook handler leaves the user with **silence** (top-level catch only logs). Fail fast at boot; apologize on crash.

**Files:**
- Modify: `server.js` (two spots: after the `process.env` destructuring near line 55, and the webhook `catch` near line 2616)

**Interfaces:**
- Consumes: nothing new.
- Produces: no exported API. Behavior only.

- [ ] **Step 1: Add env validation immediately after the `const {...} = process.env;` block**

```js
// Fail fast on required env; warn on optional. A missing required var
// otherwise surfaces as a confusing mid-request auth error.
const REQUIRED_ENV = ["VERIFY_TOKEN", "WHATSAPP_TOKEN", "PHONE_NUMBER_ID", "GOOGLE_SHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON"];
const OPTIONAL_ENV = ["ANTHROPIC_API_KEY", "DRIVE_FOLDER_ID", "ADMIN_NUMBERS", "CRM_SHEET_ID"];
{
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`❌ Missing required env vars: ${missing.join(", ")} — refusing to start.`);
    process.exit(1);
  }
  for (const k of OPTIONAL_ENV.filter((k) => !process.env[k])) {
    console.warn(`⚠️  Optional env var ${k} is not set — related features are disabled.`);
  }
}
```

- [ ] **Step 2: Replace the webhook's final `catch` block**

Current:

```js
  } catch (err) {
    console.error("Handler error:", err.message);
  }
```

New:

```js
  } catch (err) {
    console.error("Handler error:", err.stack || err.message);
    // Never leave the user with silence on a crash.
    try {
      const from = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (from) await sendText(from, "⚠️ Something went wrong on my side. Please try that again — or type *menu* to see what I can do.");
    } catch (_) { /* the apology itself failed; nothing more to do */ }
  }
```

- [ ] **Step 3: Verify**

Run: `node --check server.js` then `npm test`
Expected: both clean. Also run `node -e "delete process.env.VERIFY_TOKEN; require('./server.js')"` from the repo root only if a `.env` without VERIFY_TOKEN can be simulated — otherwise skip (dotenv loads `.env` inside server.js, so this check fires in deployed envs, which is the point).

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: validate env at boot, reply to user on handler crash"
```

---

### Task 3: Unified session store (`lib/session-store.js`)

`server.js` keeps **8 separate per-user stores** (`pendingLists`, `pendingMenu`, `pendingMtz`, `pendingSplit`, `scheduleSessions`, `splitResults`, `scheduleResults`, `pendingUnitList`), each with its own TTL constant and hand-rolled expiry — and `pendingLists` has **no TTL at all** (a slow leak). Replace with one store that models two kinds of state:

- **flow** — the single active guided flow (split / mtz / schedule). Exclusive: starting one replaces another. Expiry is *reported* (so the router can send the right "timed out" message).
- **ctx** — named auxiliary state (open menu, numbered list, print results, unit-list toggle). Multiple keys coexist; expiry is silent.

VRF sessions stay inside `vrf/vrfHandler.js` (constraint: don't touch `vrf/`); the router keeps checking `vrfSessions` directly.

**Files:**
- Create: `lib/session-store.js`
- Modify: `server.js` (replace all 8 stores + their TTL constants and expiry code)
- Test: `tests/session-store.test.js`

**Interfaces:**
- Produces (consumed by Tasks 8, 10, 11, 12):
  - `startFlow(from, type, data = {}, ttlMs = 600000)` → `data`
  - `getFlow(from)` → `{ type, data, ts }` | `{ expired: true, type }` | `null`
  - `touchFlow(from)` — refresh activity timestamp
  - `endFlow(from)`
  - `setCtx(from, key, data, ttlMs)` / `getCtx(from, key)` → `data | null` / `clearCtx(from, key)`
  - `clearAll(from)` — end flow and all ctx (used by the global menu/cancel escapes)

- [ ] **Step 1: Write the failing tests**

Create `tests/session-store.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const store = require("../lib/session-store.js");

test("flow lifecycle: start, get, touch, end", () => {
  store.startFlow("u1", "split", { step: "brand" }, 60_000);
  const f = store.getFlow("u1");
  assert.equal(f.type, "split");
  assert.equal(f.data.step, "brand");
  f.data.step = "condition"; // callers mutate data in place, like today
  assert.equal(store.getFlow("u1").data.step, "condition");
  store.endFlow("u1");
  assert.equal(store.getFlow("u1"), null);
});

test("starting a flow replaces the previous one", () => {
  store.startFlow("u2", "split", {}, 60_000);
  store.startFlow("u2", "mtz", { step: "load" }, 60_000);
  assert.equal(store.getFlow("u2").type, "mtz");
});

test("expired flow reports { expired, type } exactly once", () => {
  store.startFlow("u3", "schedule", {}, -1); // already expired
  const f = store.getFlow("u3");
  assert.deepEqual(f, { expired: true, type: "schedule" });
  assert.equal(store.getFlow("u3"), null); // reported once, then gone
});

test("ctx: independent keys, silent expiry", () => {
  store.setCtx("u4", "menu", { options: [1, 2] }, 60_000);
  store.setCtx("u4", "list", ["a.pdf"], -1); // already expired
  assert.deepEqual(store.getCtx("u4", "menu"), { options: [1, 2] });
  assert.equal(store.getCtx("u4", "list"), null);
});

test("clearAll wipes flow and ctx", () => {
  store.startFlow("u5", "split", {}, 60_000);
  store.setCtx("u5", "menu", {}, 60_000);
  store.clearAll("u5");
  assert.equal(store.getFlow("u5"), null);
  assert.equal(store.getCtx("u5", "menu"), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/session-store.js'`

- [ ] **Step 3: Implement `lib/session-store.js`**

```js
// ============================================================
//  Unified per-user conversation state.
//  - flow: the ONE active guided flow (split / mtz / schedule).
//    Exclusive per user. Expiry is reported once ({expired,type})
//    so the router can send the right "session timed out" message.
//  - ctx:  named auxiliary state (open menu, numbered list, print
//    results, unit-list toggle). Keys coexist; expiry is silent.
//  All state is in-memory: it does not survive a restart, matching
//  the pre-existing behavior of the 8 stores this replaces.
// ============================================================

const DEFAULT_TTL = 10 * 60 * 1000;

const flows = new Map(); // from -> { type, data, ts, ttl }
const ctxs = new Map();  // from -> Map(key -> { data, ts, ttl })

function startFlow(from, type, data = {}, ttlMs = DEFAULT_TTL) {
  flows.set(from, { type, data, ts: Date.now(), ttl: ttlMs });
  return data;
}

function getFlow(from) {
  const f = flows.get(from);
  if (!f) return null;
  if (Date.now() - f.ts > f.ttl) {
    flows.delete(from);
    return { expired: true, type: f.type };
  }
  return f;
}

function touchFlow(from) {
  const f = flows.get(from);
  if (f) f.ts = Date.now();
}

function endFlow(from) {
  flows.delete(from);
}

function setCtx(from, key, data, ttlMs = DEFAULT_TTL) {
  let m = ctxs.get(from);
  if (!m) { m = new Map(); ctxs.set(from, m); }
  m.set(key, { data, ts: Date.now(), ttl: ttlMs });
  return data;
}

function getCtx(from, key) {
  const m = ctxs.get(from);
  const e = m && m.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > e.ttl) { m.delete(key); return null; }
  return e.data;
}

function clearCtx(from, key) {
  const m = ctxs.get(from);
  if (m) m.delete(key);
}

function clearAll(from) {
  flows.delete(from);
  ctxs.delete(from);
}

// Sweep dead entries so abandoned sessions don't accumulate forever.
const SWEEP_MS = 5 * 60 * 1000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [from, f] of flows) if (now - f.ts > f.ttl) flows.delete(from);
  for (const [from, m] of ctxs) {
    for (const [k, e] of m) if (now - e.ts > e.ttl) m.delete(k);
    if (!m.size) ctxs.delete(from);
  }
}, SWEEP_MS);
if (sweeper.unref) sweeper.unref();

module.exports = { startFlow, getFlow, touchFlow, endFlow, setCtx, getCtx, clearCtx, clearAll, DEFAULT_TTL };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Migrate `server.js` onto the store**

Add near the other requires: `const store = require("./lib/session-store.js");`

Then apply this mechanical mapping everywhere in `server.js` (delete the old declarations `pendingLists`, `pendingMenu`, `pendingMtz`, `pendingSplit`, `scheduleSessions`, `splitResults`, `scheduleResults`, `pendingUnitList` and their TTL constants `MENU_TTL_MS`, `MTZ_TIMEOUT_MS`, `SPLIT_TIMEOUT_MS`, `SCHEDULE_TIMEOUT_MS`, `SPLIT_RESULT_TTL`, `SCHEDULE_RESULT_TTL`, `UNIT_LIST_TTL`):

| Old | New |
|---|---|
| `pendingSplit[from] = { step: "brand", ts: Date.now() }` | `store.startFlow(from, "split", { step: "brand" })` |
| `pendingSplit[from]` (read) | `store.getFlow(from)` → guard `f && f.type === "split"` → use `f.data` |
| `delete pendingSplit[from]` | `store.endFlow(from)` |
| `pendingMtz[from] = {...}` | `store.startFlow(from, "mtz", {...})` |
| `scheduleSessions.set(from, {...})` | `store.startFlow(from, "schedule", {...})` |
| `scheduleSessions.has(from)/get/delete` | `store.getFlow(from)` type-check / `.data` / `store.endFlow(from)` |
| `pendingMenu[from] = { options, ts }` | `store.setCtx(from, "menu", { options }, 15 * 60 * 1000)` |
| `pendingMenu[from]` read + TTL check | `store.getCtx(from, "menu")` (TTL handled inside) |
| `pendingLists[from] = matchedFiles` | `store.setCtx(from, "list", matchedFiles, 30 * 60 * 1000)` |
| `splitResults[from] = {...}` | `store.setCtx(from, "splitResult", {...}, 30 * 60 * 1000)` |
| `scheduleResults[from] = {...}` | `store.setCtx(from, "scheduleResult", {...}, 30 * 60 * 1000)` |
| `pendingUnitList[from] = {...}` | `store.setCtx(from, "unitList", {...}, 30 * 60 * 1000)` |

The per-flow timeout checks at the top of `handleSplitStep`/`handleMtzStep` and in the schedule/VRF session branches (`if (Date.now() - s.ts > ..._TIMEOUT_MS)`) are replaced by one shared check where the router dispatches flows (the VRF branch keeps its own — `vrf/` is untouched):

```js
    // ── Active guided flow (split / mtz / schedule) ─────────────
    const flow = store.getFlow(from);
    if (flow?.expired) {
      const names = { split: "Split Selection", mtz: "MTZ Selection", schedule: "Schedule Selection" };
      return await sendText(from, `⏰ ${names[flow.type] || "Your"} session timed out. Type *${names[flow.type] || "menu"}* to start again.`);
    }
    if (flow) store.touchFlow(from);
```

and each old `if (pendingSplit[from]) return await handleSplitStep(from, text)` becomes `if (flow?.type === "split") return await handleSplitStep(from, flow.data, text)` (pass `flow.data` as `s`; update the handlers' signatures to accept it and drop their internal `const s = pendingX[from]` + timeout lines). Note: the flow check must run **after** the media-accepting branches (VRF, schedule `awaitImage`) exactly as the current ordering does — schedule is a flow, so dispatch `flow?.type === "schedule"` where `scheduleSessions.has(from)` is today, before the `if (message.type !== "text") return;` line.

The global menu escape (`isMenuTrigger` branch near line 2106) becomes:

```js
    if (message.type === "text" && isMenuTrigger(message.text.body)) {
      vrfSessions.delete(from);
      store.clearAll(from);
      ...
```

- [ ] **Step 6: Verify**

Run: `npm test && node --check server.js`
Expected: clean. Then grep for leftovers: `grep -nE "pendingSplit|pendingMtz|pendingMenu|pendingLists|scheduleSessions|splitResults|scheduleResults|pendingUnitList" server.js` — expected: **no matches**.

- [ ] **Step 7: Commit**

```bash
git add lib/session-store.js tests/session-store.test.js server.js
git commit -m "refactor: unify 8 per-user state stores into lib/session-store"
```

---

### Task 4: Extract Google plumbing (`lib/google.js`) and Drive index (`lib/drive-index.js`)

Pure verbatim moves. No behavior change.

**Files:**
- Create: `lib/google.js`, `lib/drive-index.js`
- Modify: `server.js`

**Interfaces:**
- Produces `lib/google.js` exports: `getGoogleAccessToken`, `getAuthedClient`, `getSheets`, `getDrive`, `withRetry`, `driveFileId`, `downloadBytes`, `normalizeDriveLink`, `parseServiceAccount`
- Produces `lib/drive-index.js` exports: `listFolderFiles`, `docTypeFromFilename`, `folderMatchesDocType`, `fileMatchesDocType`, `findFilesInFolder`, `findExactFileInDoc`, `findDatasheetFiles`, `findChillerDatasheetFiles`, `displayName`

- [ ] **Step 1: Create `lib/google.js`**

Move these from `server.js`, **verbatim, including their comment blocks** (they document hard-won host bugs — the IPv6 note, the gaxios/node-fetch "Premature close" note): `parseServiceAccount`, `GOOGLE_SCOPES`, `googleToken`, `getGoogleAccessToken`, `oauthClient`, `getAuthedClient`, `withRetry`, `getSheets`, `getDrive`, `driveFileId`, `downloadBytes`, `normalizeDriveLink`. Module header:

```js
// ============================================================
//  Google service-account auth + Sheets/Drive clients.
//  Token is minted via axios (NOT gaxios/node-fetch) — see the
//  comments below; do not "simplify" back to the SDK's own flow.
// ============================================================
const crypto = require("crypto");
const axios = require("axios");
const { google } = require("googleapis");

const { GOOGLE_SERVICE_ACCOUNT_JSON } = process.env;
```

…then the moved code, then:

```js
module.exports = {
  parseServiceAccount, getGoogleAccessToken, getAuthedClient, withRetry,
  getSheets, getDrive, driveFileId, downloadBytes, normalizeDriveLink,
};
```

Note: the `dns.setDefaultResultOrder("ipv4first")` line **stays at the top of `server.js`** (it must run before any outbound request, and server.js is the entrypoint). `downloadBytes` references `driveFileId` and `getDrive` — all in this module. `require("dotenv").config()` currently runs *after* the env destructure in server.js and works because Render injects real env vars; move `require("dotenv").config();` to **line 1 of server.js** (before any require that reads `process.env`) so `lib/google.js` sees `.env` values in local dev too.

- [ ] **Step 2: Create `lib/drive-index.js`**

Move verbatim from `server.js`: `fileIndex`, `FILE_CACHE_MS`, `listFolderFiles`, `docTypeFromFilename`, `folderMatchesDocType`, `fileMatchesDocType`, `findFilesInFolder`, `findExactFileInDoc`, `findDatasheetFiles`, `findChillerDatasheetFiles`, `displayName` (from near line 1178). Header + deps:

```js
// ============================================================
//  Recursive Drive file index (cached) + doc-type/file matching.
//  Doc type is decided by FOLDER (Catalogue(s)/IOM(s)) with the
//  _IOM/_catalogue filename suffix as a secondary signal.
// ============================================================
const { getDrive, withRetry } = require("./google.js");
const { folderToDocType, datasheetFolderForSeries, datasheetCondition, DATASHEET_FOLDERS } = require("../catalogue-map.js");

const { DRIVE_FOLDER_ID } = process.env;
```

Exports: all names listed in Interfaces above.

- [ ] **Step 3: Rewire `server.js`**

Delete the moved code from `server.js`; add:

```js
const { getSheets, getDrive, withRetry, driveFileId, downloadBytes, normalizeDriveLink } = require("./lib/google.js");
const {
  listFolderFiles, docTypeFromFilename, folderMatchesDocType, fileMatchesDocType,
  findFilesInFolder, findExactFileInDoc, findDatasheetFiles, findChillerDatasheetFiles, displayName,
} = require("./lib/drive-index.js");
```

Keep `crm.init({ getSheets })` working (it now receives the imported function).

- [ ] **Step 4: Verify**

Run: `npm test && node --check server.js && node --check lib/google.js && node --check lib/drive-index.js`
Then confirm no orphan references: `grep -nE "function (getGoogleAccessToken|getAuthedClient|listFolderFiles|findFilesInFolder)" server.js` — expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add lib/google.js lib/drive-index.js server.js
git commit -m "refactor: extract Google auth and Drive index into lib/"
```

---

### Task 5: Extract WhatsApp transport (`lib/wa.js`) with tested payload builders

All Graph-API send/upload code moves to `lib/wa.js`. New pure builders (`buildButtonsPayload`, `buildListPayload`) get unit tests — the button-title dedupe logic (issue #131009) finally becomes testable.

**Files:**
- Create: `lib/wa.js`
- Modify: `server.js`
- Test: `tests/wa-builders.test.js`

**Interfaces:**
- Produces `lib/wa.js` exports (consumed by server.js and Tasks 8–11):
  - `send(to, payload)` → **now returns `true` on success / `false` on failure** (previously undefined; needed by the media-ID cache in Task 8)
  - `sendText(to, body)`, `sendLongText(to, body, limit?)`, `sendButtons(to, bodyText, buttons)`, `sendDocument(to, buffer, filename, caption)`, `sendPdfBuffer(to, buffer, filename, caption)`, `sendDriveFile(to, file)`
  - `sendList(to, bodyText, buttonLabel, rows)` — NEW interactive list message; `rows = [{ id, title, description? }]`
  - `markReadWithTyping(messageId)` — NEW
  - `uploadMedia`, `uploadMediaBuffer`, `downloadWhatsAppMedia`, `mimeFromName`, `validatePdfBuffer`
  - `buildButtonsPayload(to, bodyText, buttons)`, `buildListPayload(to, bodyText, buttonLabel, rows)` — pure, for tests
  - `NOT_FOUND_MSG`, `fileTooLargeMessage`, `WHATSAPP_MAX_FILE_BYTES`

- [ ] **Step 1: Write the failing builder tests**

Create `tests/wa-builders.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { buildButtonsPayload, buildListPayload } = require("../lib/wa.js");

test("buttons: caps at 3, trims titles to 20 chars, dedupes colliding titles", () => {
  const p = buildButtonsPayload("974x", "pick one", [
    { id: "a", title: "Trane Catalogue 2025 Part 1" },
    { id: "b", title: "Trane Catalogue 2025 Part 2" },
    { id: "c", title: "Short" },
    { id: "d", title: "dropped (4th)" },
  ]);
  const btns = p.interactive.action.buttons;
  assert.equal(btns.length, 3);
  for (const b of btns) assert.ok(b.reply.title.length <= 20);
  const titles = btns.map((b) => b.reply.title);
  assert.equal(new Set(titles).size, titles.length, "titles must be unique after trimming");
});

test("list: caps at 10 rows, trims title/description to API limits", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: `fileid|${i}`,
    title: "A very long product datasheet name indeed " + i,
    description: "x".repeat(100),
  }));
  const p = buildListPayload("974x", "body", "Choose a document", rows);
  const out = p.interactive.action.sections[0].rows;
  assert.equal(out.length, 10);
  for (const r of out) {
    assert.ok(r.title.length <= 24);
    assert.ok(r.description.length <= 72);
  }
  assert.ok(p.interactive.action.button.length <= 20);
  assert.equal(p.interactive.type, "list");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/wa.js'`

- [ ] **Step 3: Create `lib/wa.js`**

Move verbatim from `server.js`: `GRAPH_URL`, `MEDIA_URL`, `EXT_MIME`, `mimeFromName`, `validatePdfBuffer`, `uploadMedia`, `uploadMediaBuffer`, `downloadWhatsAppMedia`, `sendText`, `sendLongText`, `sendButtons`, `sendDocument`, `sendDriveFile`, `sendPdfBuffer`, `send`, `NOT_FOUND_MSG`, `WHATSAPP_MAX_FILE_BYTES`, `fileTooLargeMessage`. Header:

```js
// ============================================================
//  WhatsApp Cloud API transport: send text/buttons/lists/docs,
//  media upload/download, read receipts + typing indicator.
// ============================================================
const axios = require("axios");
const FormData = require("form-data");
const crm = require("../crm.js");
const { downloadBytes } = require("./google.js");
const { MENU_HINT } = require("../menu.js");

const { WHATSAPP_TOKEN, PHONE_NUMBER_ID } = process.env;
const GRAPH_URL = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
```

Refactor `sendButtons` minimally so the existing dedupe/trim logic lives in a pure builder (same logic, moved):

```js
function buildButtonsPayload(to, bodyText, buttons) {
  // WhatsApp rejects the whole message (#131009 "Duplicate button title") if any
  // two buttons share a title. Titles are capped at 20 chars, so names that only
  // differ past char 20 collide once trimmed. Disambiguate with a " (n)" suffix.
  const seen = new Map();
  const trimmed = buttons.slice(0, 3).map((b) => {
    let title = (b.title || "").slice(0, 20);
    const count = seen.get(title) || 0;
    if (count > 0) {
      const suffix = ` (${count + 1})`;
      title = title.slice(0, 20 - suffix.length) + suffix;
    }
    seen.set((b.title || "").slice(0, 20), count + 1);
    return { type: "reply", reply: { id: b.id, title } };
  });
  return {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: { type: "button", body: { text: bodyText.slice(0, 1024) }, action: { buttons: trimmed } },
  };
}
async function sendButtons(to, bodyText, buttons) {
  return send(to, buildButtonsPayload(to, bodyText, buttons));
}
```

Add the new list + typing helpers:

```js
// Interactive list message: one section, up to 10 tappable rows. Better UX
// than "reply with a number" for 4-10 options. rows: [{id, title, description?}].
function buildListPayload(to, bodyText, buttonLabel, rows) {
  return {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "list",
      body: { text: (bodyText || "").slice(0, 4096) },
      action: {
        button: (buttonLabel || "Choose").slice(0, 20),
        sections: [{
          rows: rows.slice(0, 10).map((r) => ({
            id: String(r.id).slice(0, 200),
            title: (r.title || "").slice(0, 24),
            ...(r.description ? { description: String(r.description).slice(0, 72) } : {}),
          })),
        }],
      },
    },
  };
}
async function sendList(to, bodyText, buttonLabel, rows) {
  return send(to, buildListPayload(to, bodyText, buttonLabel, rows));
}

// Mark the inbound message read and show a typing indicator. The indicator
// clears when we send a reply (or after ~25s). Fire-and-forget: a failure
// here must never affect the actual reply.
async function markReadWithTyping(messageId) {
  if (!messageId) return;
  try {
    await axios.post(GRAPH_URL, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("typing-indicator error:", err.response?.data?.error?.message || err.message);
  }
}
```

Change `send` to report success (same logging, new return):

```js
async function send(to, payload) {
  crm.logOutbound(to, payload);
  try {
    await axios.post(GRAPH_URL, payload, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    });
    console.log(`✅ Sent ${payload.type} to ${to}`);
    return true;
  } catch (err) {
    console.error("❌ Send error:", err.response?.data || err.message);
    return false;
  }
}
```

Export everything listed in Interfaces.

- [ ] **Step 4: Rewire `server.js`**

Delete moved code; add:

```js
const wa = require("./lib/wa.js");
const {
  send, sendText, sendLongText, sendButtons, sendList, sendDocument, sendDriveFile,
  sendPdfBuffer, uploadMedia, uploadMediaBuffer, downloadWhatsAppMedia, markReadWithTyping,
  NOT_FOUND_MSG, fileTooLargeMessage,
} = wa;
```

`sendRule`, `sendFileOptions`, `sendListWithToggle`, `sendChillerResponse`, `sendNotFoundWithSuggestions` stay in `server.js` (they mix routing state with transport). `initVrf({ sendText, sendDocument })` keeps working with the imported functions.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test && node --check server.js && node --check lib/wa.js`
Expected: all PASS, both checks clean.

- [ ] **Step 6: Commit**

```bash
git add lib/wa.js tests/wa-builders.test.js server.js
git commit -m "refactor: extract WhatsApp transport to lib/wa with tested payload builders"
```

---

### Task 6: Shared intent table (`intents.js`) — kill the router/CRM mirror

`crm.classify()` hand-mirrors the webhook's routing order ("classify() must mirror router order" is a documented landmine). Extract the ordered predicates into one table both sides consume, with a test that locks the order.

**Files:**
- Create: `intents.js`
- Modify: `crm.js` (classify delegates), `server.js` (no change required — its if-chain already calls the same parsers; the table just names the order)
- Test: `tests/intents.test.js`

**Interfaces:**
- Produces: `INTENTS` — ordered `[{ name, match(text) → truthy|falsy }]`; `classify(text)` → intent name string.
- `crm.js` consumes `classify`.

- [ ] **Step 1: Write the failing tests**

Create `tests/intents.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { classify, INTENTS } = require("../intents.js");

test("intent order matches the webhook router order", () => {
  assert.deepEqual(INTENTS.map((i) => i.name), [
    "media", "button-tap", "numbered-reply", "menu", "small-talk", "admin-stats",
    "vrf-selection", "schedule-selection", "split-selection", "mtz-selection", "print",
    "split-list", "list-units", "question", "chiller", "datasheet", "selection",
    "catalogue-iom", "model-code", "doc-search",
  ]);
});

test("classify routes representative messages like the router does", () => {
  assert.equal(classify("hi"), "menu");
  assert.equal(classify("thanks"), "small-talk");
  assert.equal(classify("VRF Selection"), "vrf-selection");
  assert.equal(classify("Schedule Selection"), "schedule-selection");
  assert.equal(classify("Split Selection"), "split-selection");
  assert.equal(classify("MTZ Selection"), "mtz-selection");
  assert.equal(classify("print"), "print");
  assert.equal(classify("list of split units"), "split-list");
  assert.equal(classify("list APMR units"), "list-units");
  assert.equal(classify("what is the capacity of APMR 52340?"), "question");
  assert.equal(classify("package unit 20 tr t3"), "selection");
  assert.equal(classify("APMR catalogue"), "catalogue-iom");
  assert.equal(classify("random gibberish xyz"), "other");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../intents.js'`

- [ ] **Step 3: Implement `intents.js`**

Port the body of `crm.classify()` (crm.js lines 40–66) into an ordered table. **This is the single source of routing order** — if the webhook if-chain in server.js ever changes order, change it here too (one place now instead of two mirrored ones):

```js
// ============================================================
//  Ordered intent table — the ONE place that encodes the webhook
//  router's dispatch order. crm.classify() consumes it; the
//  server.js if-chain follows the same order (see tests).
//  match(text) must be sync, cheap, and side-effect free.
// ============================================================
const { parseDatasheetRequest, buildSelectionInteractive, parseSeriesRequest, interpretCode } = require("./products.js");
const { routeChillerText } = require("./chillers.js");
const { parseListRequest } = require("./product-facts.js");
const { parseSplitListRequest } = require("./split-engine.js");
const { isMenuTrigger, smallTalkReply } = require("./menu.js");
const { isVrfTrigger } = require("./vrf/trigger.js");

const MENTIONS_DOC = /\b(datasheet|data ?sheet|catalog(?:ue)?|iom|manual|brochure|drawing|pdf|document|file)\b/i;
const QUESTION_WORDS = /\b(what|whats|what's|how many|how much|which|tell me|explain|compare|difference|capacity|cooling|airflow|eer|iplv|tonnage|weight|dimensions?|sound|dba|refrigerant)\b/i;

const safe = (fn) => (t) => { try { return fn(t); } catch (_) { return null; } };

const INTENTS = [
  { name: "media",              match: (t) => /^\[(image|document|audio|video|sticker)\]$/.test(t) },
  { name: "button-tap",         match: (t) => t.startsWith("btn:") },
  { name: "numbered-reply",     match: (t) => /^\d+$/.test(t) },
  { name: "menu",               match: (t) => isMenuTrigger(t) },
  { name: "small-talk",         match: (t) => !!smallTalkReply(t) },
  { name: "admin-stats",        match: (t) => /^stats$/i.test(t) },
  { name: "vrf-selection",      match: (t) => isVrfTrigger(t) },
  { name: "schedule-selection", match: (t) => /^(image|boq|schedule)\s+selection$/i.test(t) },
  { name: "split-selection",    match: (t) => /^split\s+selection$/i.test(t) },
  { name: "mtz-selection",      match: (t) => /^mtz(\s+selection)?\b/i.test(t) },
  { name: "print",              match: (t) => /^(print|datasheet)$/i.test(t) },
  { name: "split-list",         match: safe(parseSplitListRequest) },
  { name: "list-units",         match: safe(parseListRequest) },
  { name: "question",           match: (t) => !MENTIONS_DOC.test(t) && (/\?/.test(t) || QUESTION_WORDS.test(t)) },
  { name: "chiller",            match: safe(routeChillerText) },
  { name: "datasheet",          match: safe(parseDatasheetRequest) },
  { name: "selection",          match: safe(buildSelectionInteractive) },
  { name: "catalogue-iom",      match: safe(parseSeriesRequest) },
  { name: "model-code",         match: safe(interpretCode) },
  { name: "doc-search",         match: (t) => MENTIONS_DOC.test(t) },
];

function classify(text) {
  const t = (text || "").trim();
  if (!t) return "empty";
  for (const i of INTENTS) if (i.match(t)) return i.name;
  if (/\b(price|cost|warranty|deliver|contact|hours)\b/i.test(t)) return "question";
  return "other";
}

module.exports = { INTENTS, classify };
```

Caveat: `datasheet` here classifies **both** the bare `print`/`datasheet` reply and full requests; the `print` entry above it disambiguates, matching how the router checks Print before the free-form band.

- [ ] **Step 4: Slim `crm.js`**

Replace crm.js's whole `classify` function (lines 40–66) and its now-unused requires (`products.js`, `chillers.js`, `product-facts.js`, `vrf/trigger.js`, and the `isMenuTrigger/smallTalkReply` import if unused elsewhere in crm.js) with:

```js
const { classify } = require("./intents.js");
```

Keep exporting `classify` from crm.js (`module.exports` already lists it) so existing callers don't change.

**Circular-require check:** `lib/wa.js → crm.js → intents.js → products.js/menu.js/…` — none of those require wa.js or crm.js back, so no cycle. Verify with `node -e "require('./lib/wa.js'); require('./intents.js'); console.log('ok')"`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS (if a classify test fails, check the corresponding parser's actual behavior — the table must reflect the *router's* real order, which is the order given).

- [ ] **Step 6: Commit**

```bash
git add intents.js tests/intents.test.js crm.js
git commit -m "refactor: single ordered intent table shared by router and CRM"
```

---

### Task 7: Per-user message serialization (`lib/user-queue.js`)

The webhook returns 200 immediately and handles messages concurrently. Two rapid messages from the same user (very common: users double-text) can interleave inside one flow's state machine — e.g. two schedule images both entering extraction, or a capacities line racing a cancel. Serialize handling per user; different users stay fully concurrent.

**Files:**
- Create: `lib/user-queue.js`
- Modify: `server.js` (webhook wraps its body in the queue)
- Test: `tests/user-queue.test.js`

**Interfaces:**
- Produces: `enqueue(key, fn)` → Promise of `fn()`'s result; calls with the same `key` run strictly in arrival order; errors don't break the chain.

- [ ] **Step 1: Write the failing tests**

Create `tests/user-queue.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { enqueue } = require("../lib/user-queue.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("same key runs in order even when the first call is slow", async () => {
  const order = [];
  const p1 = enqueue("u1", async () => { await sleep(30); order.push("a"); });
  const p2 = enqueue("u1", async () => { order.push("b"); });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["a", "b"]);
});

test("different keys run concurrently", async () => {
  const order = [];
  const p1 = enqueue("u2", async () => { await sleep(30); order.push("slow"); });
  const p2 = enqueue("u3", async () => { order.push("fast"); });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["fast", "slow"]);
});

test("an error in one task does not block the next", async () => {
  const order = [];
  const p1 = enqueue("u4", async () => { throw new Error("boom"); });
  const p2 = enqueue("u4", async () => { order.push("after"); });
  await assert.rejects(p1);
  await p2;
  assert.deepEqual(order, ["after"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/user-queue.js'`

- [ ] **Step 3: Implement `lib/user-queue.js`**

```js
// ============================================================
//  Per-key task serialization. Messages from the same user are
//  handled strictly in arrival order so a double-text can't
//  interleave inside a flow's state machine. Different users
//  remain fully concurrent.
// ============================================================
const tails = new Map(); // key -> tail promise of that user's chain

function enqueue(key, fn) {
  const prev = tails.get(key) || Promise.resolve();
  const run = prev.then(fn, fn); // run next regardless of the previous outcome
  // The stored tail swallows rejection so the chain never becomes a
  // permanently-rejected promise; callers still see `run`'s real result.
  const tail = run.catch(() => {});
  tails.set(key, tail);
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}

module.exports = { enqueue };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Wire into the webhook**

In `server.js`, extract the current webhook body (everything from `const value = ...` through the end of the try, i.e. the whole message-handling pipeline) into `async function handleIncomingMessage(value, message)`, and make the route:

```js
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  const value = req.body.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  if (!message) return;
  if (message.id && isDuplicate(message.id)) {
    console.log(`⚡ Duplicate message ${message.id} — skipped`);
    return;
  }
  enqueue(message.from, async () => {
    try {
      await handleIncomingMessage(value, message);
    } catch (err) {
      console.error("Handler error:", err.stack || err.message);
      try {
        await sendText(message.from, "⚠️ Something went wrong on my side. Please try that again — or type *menu* to see what I can do.");
      } catch (_) {}
    }
  });
});
```

(The dedupe check stays *outside* the queue so retries are dropped instantly. The Task 2 crash-reply moves in here, simplified — `message.from` is now in scope.)

- [ ] **Step 6: Verify + commit**

Run: `npm test && node --check server.js`

```bash
git add lib/user-queue.js tests/user-queue.test.js server.js
git commit -m "feat: serialize message handling per user to prevent flow races"
```

---

### Task 8: WhatsApp media-ID cache for Drive files

Every document send downloads the PDF from Drive and re-uploads it to WhatsApp — even for the same file requested minutes apart (catalogues are requested constantly). WhatsApp media IDs stay valid for ~30 days; cache them per Drive file ID for 48h and skip the whole download/upload round-trip on a hit. Fall back transparently if WhatsApp rejects a cached ID.

**Files:**
- Modify: `lib/wa.js` (`sendDriveFile`)

**Interfaces:**
- Consumes: `send()` returning `true|false` (Task 5).
- Produces: no API change — `sendDriveFile(to, file)` behaves identically, just faster on repeats.

- [ ] **Step 1: Add the cache and the fast path to `lib/wa.js`**

Above `sendDriveFile`:

```js
// Drive file id -> { mediaId, ts }. WhatsApp media ids live ~30 days; we cap
// at 48h so a replaced Drive file (same id, new content) goes stale quickly.
// A rejected cached id falls through to the normal download+upload path.
const MEDIA_ID_TTL = 48 * 60 * 60 * 1000;
const mediaIdCache = new Map();
```

Inside `sendDriveFile`, after `const caption = ...` and before the `isImage` branch, insert:

```js
  const cached = mediaIdCache.get(file.id);
  if (cached && Date.now() - cached.ts < MEDIA_ID_TTL) {
    const payload = isImage
      ? { messaging_product: "whatsapp", to, type: "image", image: { id: cached.mediaId, caption } }
      : { messaging_product: "whatsapp", to, type: "document", document: { id: cached.mediaId, filename: file.name, caption } };
    if (await send(to, payload)) {
      console.log(`⚡ media-id cache hit: ${file.name}`);
      return;
    }
    mediaIdCache.delete(file.id); // stale/rejected -> re-upload below
  }
```

Then, in each success path, populate the cache: in the image branch after `uploadMedia` succeeds and in the document branch after `uploadMediaBuffer` succeeds, capture the id and store it:

```js
      mediaIdCache.set(file.id, { mediaId, ts: Date.now() });
```

(both branches already have `mediaId` in scope; add the line immediately before the final `send(...)` call of each branch).

- [ ] **Step 2: Verify**

Run: `npm test && node --check lib/wa.js`
Expected: clean. (Behavioral verification happens in production logs: look for `⚡ media-id cache hit` on the second request of the same catalogue.)

- [ ] **Step 3: Commit**

```bash
git add lib/wa.js
git commit -m "perf: cache WhatsApp media ids per Drive file (48h) to skip re-upload"
```

---

### Task 9: Mark-as-read + typing indicator on every inbound message

The bot currently looks "unread and silent" during Drive scans and AI calls, papered over by "🔍 Searching…" filler texts. Read receipt + typing indicator is the native WhatsApp affordance: instant blue ticks + "typing…" until the reply lands.

**Files:**
- Modify: `server.js` (top of `handleIncomingMessage`)

**Interfaces:**
- Consumes: `markReadWithTyping(messageId)` from `lib/wa.js` (Task 5).

- [ ] **Step 1: Call it first thing in `handleIncomingMessage`**

Immediately after `const from = message.from;` add:

```js
    // Blue-tick + "typing…" right away; clears when our reply sends.
    markReadWithTyping(message.id); // fire-and-forget by design
```

(No `await` — it must not add latency to the real reply.)

- [ ] **Step 2: Keep the "Searching…" texts — but only for genuinely slow paths**

The `announceSearch()` mechanism stays (a Drive cold scan + AI match can exceed the ~25s typing-indicator window). No change needed; this step is a decision record.

- [ ] **Step 3: Verify + commit**

Run: `npm test && node --check server.js`

```bash
git add server.js
git commit -m "feat(ux): mark inbound messages read and show typing indicator"
```

---

### Task 10: Welcome menu as a native interactive list

The welcome menu is a "reply with a number" text. WhatsApp list messages give tappable rows — one tap instead of typed numbers, no typos, and the numbered fallback still works for users who type anyway.

**Files:**
- Modify: `menu.js` (add short titles + list builder), `server.js` (send list, handle `list_reply`)
- Test: `tests/menu.test.js` (extend)

**Interfaces:**
- Produces from `menu.js`: `welcomeMenuList(name, returning)` → `{ body, buttonLabel, rows: [{id: "menu|<n>", title, description}], options }`
- `server.js` gains a `list_reply` branch handling `menu|<n>` and `fileid|<driveId>` row ids (the latter used by Task 11).

- [ ] **Step 1: Write the failing test (append to `tests/menu.test.js`)**

```js
test("welcomeMenuList builds API-safe rows for every option", () => {
  const { welcomeMenuList } = require("../menu.js");
  const m = welcomeMenuList("Hassan", false);
  assert.equal(m.rows.length, MENU_OPTIONS.length);
  for (const r of m.rows) {
    assert.match(r.id, /^menu\|\d+$/);
    assert.ok(r.title.length > 0 && r.title.length <= 24, `title too long: ${r.title}`);
    assert.ok(!r.description || r.description.length <= 72);
  }
  assert.ok(m.buttonLabel.length <= 20);
  assert.match(m.body, /Welcome, Hassan/);
});
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `npm test`
Expected: FAIL — `welcomeMenuList is not a function`

- [ ] **Step 3: Implement in `menu.js`**

Add a `short` title and one-line `desc` to each entry of `MENU_OPTIONS` (row title limit is 24 chars):

```js
  // in option 1:  short: "Documents",          desc: "Catalogues, IOM manuals & model datasheets",
  // in option 2:  short: "Quick Selection",    desc: "Capacity in → model out (package, chiller, FCU)",
  // in option 3:  short: "Guided Selectors",   desc: "Schedule · VRF · MTZ · Split — step-by-step + PDF",
  // in option 4:  short: "Help",               desc: "How to ask, with copy-paste examples",
```

Then add:

```js
// Native list-message version of the welcome menu. Rows tap straight into the
// same tips as the numbered replies (ids "menu|<n>"), so both entry paths work.
function welcomeMenuList(name, returning) {
  const first = (name || "").trim().split(/\s+/)[0];
  const hello = first
    ? (returning ? `👋 *Welcome back, ${first}!*` : `👋 *Welcome, ${first}!*`)
    : "👋 *Welcome!*";
  const body =
    `${hello}\n_Mannai HVAC Assistant_ — catalogues, datasheets & equipment selections.\n\n` +
    "Tap below to see what I can do — or just type what you need, e.g. *APMR catalogue* · *Split Selection*.";
  return {
    body,
    buttonLabel: "What I can do",
    rows: MENU_OPTIONS.map((o) => ({
      id: `menu|${o.n}`,
      title: `${ICON[o.n] || ""} ${o.short}`.trim().slice(0, 24),
      description: (o.desc || "").slice(0, 72),
    })),
    options: MENU_OPTIONS,
  };
}
```

Export it: add `welcomeMenuList` to `module.exports`.

- [ ] **Step 4: Send the list from `server.js`**

Both menu branches (global escape + the later `isMenuTrigger` branch) change from `welcomeMenu(...)` + `sendText` to:

```js
      const m = welcomeMenuList(profileName, crm.isKnownContact(from));
      store.setCtx(from, "menu", { options: m.options }, 15 * 60 * 1000); // numbered replies still work
      return await sendList(from, m.body, m.buttonLabel, m.rows);
```

(update the require from `./menu.js` to include `welcomeMenuList`).

- [ ] **Step 5: Handle `list_reply` in the webhook**

In `handleIncomingMessage`, extend the interactive branch. Where it currently checks `message.interactive?.type === "button_reply"`, add a preceding normalization so list taps reuse the whole button pipeline:

```js
    // A list-row tap carries the same kind of id as a button tap — normalize
    // and let the single button-id dispatcher below handle both.
    const tapId =
      message.type === "interactive" && message.interactive?.type === "button_reply" ? message.interactive.button_reply.id
      : message.type === "interactive" && message.interactive?.type === "list_reply" ? message.interactive.list_reply.id
      : null;
    if (tapId) {
      const btnId = tapId;
      console.log(`🔘 ${from} tapped: ${btnId}`);
      // Menu row tap -> that section's tip card.
      if (btnId.startsWith("menu|")) {
        const n = parseInt(btnId.split("|")[1], 10);
        const tip = tipFor(n);
        if (tip) return await sendText(from, tip);
        return; // stale/unknown row
      }
      ... // existing button dispatch continues unchanged (chiller, units|, fileid|, doctype|, …)
```

Also update crm's inbound text derivation in `handleIncomingMessage` so list taps are logged (where `inboundText` is computed, add a `list_reply` case mirroring the `button_reply` one, producing `btn:<title-or-id>`).

- [ ] **Step 6: Run tests, verify, commit**

Run: `npm test && node --check server.js && node --check menu.js`

```bash
git add menu.js server.js tests/menu.test.js
git commit -m "feat(ux): welcome menu as native WhatsApp interactive list"
```

---

### Task 11: File pickers (4–10 matches) as interactive lists

`sendFileOptions` falls back to a typed numbered list for 4+ matches. Use a native list for 4–10; keep the numbered text only for 11+ (API cap). Row taps arrive as `fileid|<driveId>` — already handled by the normalized dispatcher from Task 10.

**Files:**
- Modify: `server.js` (`sendFileOptions`)

**Interfaces:**
- Consumes: `sendList` (Task 5), normalized `tapId` dispatch (Task 10), `store` (Task 3).

- [ ] **Step 1: Rewrite the 4+ branch of `sendFileOptions`**

```js
async function sendFileOptions(to, matchedFiles, prompt, autoSendSingle = true) {
  if (autoSendSingle && matchedFiles.length === 1) return sendDriveFile(to, matchedFiles[0]);

  if (matchedFiles.length <= 3) {
    const buttons = matchedFiles.map((f) => ({ id: `fileid|${f.id}`, title: displayName(f).slice(0, 20) }));
    return sendButtons(to, prompt || "Which one would you like?", buttons);
  }

  // 4-10 matches: tappable list rows (title = short name, description = full name).
  if (matchedFiles.length <= 10) {
    store.clearCtx(to, "menu");
    const rows = matchedFiles.map((f) => ({
      id: `fileid|${f.id}`,
      title: displayName(f).slice(0, 24),
      description: f.name.length > 24 ? f.name : undefined,
    }));
    return sendList(to, prompt || "I found several matches:", "Choose a document", rows);
  }

  // 11+ matches: numbered text list stored for the next reply.
  store.clearCtx(to, "menu");
  store.setCtx(to, "list", matchedFiles, 30 * 60 * 1000);
  const list = matchedFiles.map((f, i) => `${i + 1}. ${displayName(f)}`).join("\n");
  return sendText(to, `${prompt || "I found several matches:"}\n\n${list}\n\nReply with a number to get the file.`);
}
```

- [ ] **Step 2: Verify + commit**

Run: `npm test && node --check server.js`

```bash
git add server.js
git commit -m "feat(ux): 4-10 file matches presented as tappable list rows"
```

---

### Task 12: Global cancel + orphan-number guard

Two dead-end papercuts:
1. `cancel`/`stop` works *inside* flows (each re-implements it) and as small talk *outside* — but the per-flow copies drift. Hoist one global cancel that ends any active flow (including VRF, whose own `exit` handling stays as a second layer).
2. A bare number with **no** open menu/list falls through to document search → nonsense results for "1". Catch it with a helpful nudge.

**Files:**
- Modify: `server.js`
- Modify: `handleSplitStep` / `handleMtzStep` (remove their now-redundant cancel blocks; schedule's inline check likewise)

**Interfaces:**
- Consumes: `store` (Task 3), `vrfSessions` (existing).

- [ ] **Step 1: Add the global cancel right after the global menu escape**

```js
    // ── Global cancel: ends ANY active flow from anywhere. Each flow used to
    // implement its own copy; this is now the single authority. (VRF keeps its
    // internal "exit" handling too — vrf/ is upstream-mirrored, untouched.)
    if (message.type === "text" && /^(cancel|stop|exit|quit|reset)$/i.test(message.text.body.trim())) {
      const hadFlow = !!store.getFlow(from) || vrfSessions.has(from);
      vrfSessions.delete(from);
      store.endFlow(from);
      if (hadFlow) {
        return await sendText(from, "✅ Cancelled. Type *menu* to see everything I can do.");
      }
      // No active flow -> fall through (smallTalkReply gives the friendly bye).
    }
```

- [ ] **Step 2: Remove the per-flow cancel blocks**

Delete the `/^(cancel|stop|exit|quit|reset)\b/i` blocks inside `handleSplitStep`, `handleMtzStep`, and the schedule-session branch — they are now unreachable (global cancel runs first). Leave the flows' *prompt copy* ("Type *cancel* anytime…") untouched.

- [ ] **Step 3: Add the orphan-number guard**

In the free-form band, immediately after the numbered-list and menu-number handlers (i.e. once we know neither a `list` ctx nor a `menu` ctx consumed the number), add:

```js
    // A bare number with no open menu/list would fall into document search and
    // return nonsense. Nudge instead.
    if (/^\d{1,2}$/.test(text)) {
      return await sendText(from, "That menu or list has expired. Type *menu* to see your options, or just tell me what you need — e.g. *APMR catalogue*.");
    }
```

Placement matters: it must come **after** the `store.getCtx(from, "list")` numbered-reply handler and **after** the `store.getCtx(from, "menu")` numbered-tip handler, and **before** the split-list/list/AI pipeline. 5-digit model codes (`52340`) are untouched — the guard only matches 1–2 digits.

- [ ] **Step 4: Verify + commit**

Run: `npm test && node --check server.js`

```bash
git add server.js
git commit -m "feat(ux): global cancel for all flows + orphan number guard"
```

---

## Self-Review Notes

- **Order dependency:** Tasks 3→5 must precede 8–12 (they consume `store`, `sendList`, `send→bool`). Task 10's normalized `tapId` dispatcher is consumed by Task 11. Tasks 1, 2, 6, 7 are independent of each other but Task 7 subsumes Task 2's catch block (documented in Task 7 Step 5).
- **Not in scope (deliberate):** persisting sessions across restarts (single Render instance; in-memory matches current behavior), the full handler-table router rewrite (the shared intent table removes the actual pain — classify drift — at a fraction of the risk), Arabic localization, VRF-flow internals, and any selection-engine change.
- **Verification of live behavior** (after deploy): send `hi` → tappable list menu; tap a row → tip card; request the same catalogue twice → second send logs `⚡ media-id cache hit`; send two messages rapidly mid-flow → handled in order; type `7` cold → nudge, not a file search; every inbound gets blue ticks + typing.
