# VRF Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "VRF Selection" feature to the WhatsApp bot: trigger on the exact phrase, take a schedule (typed / xlsx / image / PDF), run the unchanged Python engine via an HTTP sidecar, and deliver the BOQ xlsx back as a WhatsApp document.

**Architecture:** One repo, two Render services. The existing Node bot (`server.js`) calls a new Python sidecar (`vrf-sidecar/`, Docker) over HTTP. The bot's own VRF logic lives in `vrf/*.js`; the engine and sidecar code are used as-is from the provided bundle.

**Tech Stack:** Node 18+ (CommonJS, Express, Meta WhatsApp Cloud API v21.0), SheetJS (`xlsx`), Python sidecar (FastAPI + the Toshiba engine), `node:test` for the one pure unit test.

---

## Reference: source of provided files

The unzipped bundle is at `_vrf_extract/vrf-sidecar/`. It contains:
- `app.py`, `engine/`, `requirements.txt`, `Dockerfile`, `.env.example` → become `vrf-sidecar/`.
- `node-client/{vrfClient.js,vrfIntake.js,vrfHandler.js}` → become `vrf/`.

**Safety note for every commit step:** the repo working tree contains untracked secret files (`whatsapp-bot-498411-c3f0589ba5aa.json`, `_temp_sa.json`, `whatsapp-bot-498411-*.json`). **Never run `git add -A` or `git add .`** Always `git add <exact paths>`.

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `vrf-sidecar/app.py`, `engine/`, `requirements.txt`, `Dockerfile`, `.env.example` | Python engine behind HTTP. Used as-is. New Render service. |
| `vrf/vrfClient.js` | Calls sidecar `/select`; formats the reply. Minor edit (optional link). |
| `vrf/vrfIntake.js` | Guided flow + xlsx parse + image/PDF→rows. Used as-is. |
| `vrf/vrfHandler.js` | Orchestrates intake→engine→delivery. Edited: dependency injection + direct-document delivery. |
| `vrf/trigger.js` | Pure exact-phrase matcher `isVrfTrigger(text)`. New (TDD). |
| `vrf/trigger.test.js` | `node:test` unit test for the matcher. New. |
| `server.js` | New helpers `downloadWhatsAppMedia`, `uploadMediaBuffer`, `sendDocument`; webhook routing + trigger; requires + `initVrf`. |
| `.gitignore` | Add the untracked secret files so they can never be committed. |

---

## Task 1: Land the sidecar and node modules in the repo

**Files:**
- Create: `vrf-sidecar/` (moved from `_vrf_extract/vrf-sidecar/`)
- Create: `vrf/vrfClient.js`, `vrf/vrfIntake.js`, `vrf/vrfHandler.js`
- Modify: `.gitignore`

- [ ] **Step 1: Move sidecar files to a top-level folder**

```bash
mkdir -p vrf-sidecar vrf
cp -r _vrf_extract/vrf-sidecar/app.py _vrf_extract/vrf-sidecar/engine \
      _vrf_extract/vrf-sidecar/requirements.txt _vrf_extract/vrf-sidecar/Dockerfile \
      _vrf_extract/vrf-sidecar/.env.example _vrf_extract/vrf-sidecar/README.md \
      _vrf_extract/vrf-sidecar/CLAUDE_CODE_BRIEF.md vrf-sidecar/
cp _vrf_extract/vrf-sidecar/node-client/vrfClient.js \
   _vrf_extract/vrf-sidecar/node-client/vrfIntake.js \
   _vrf_extract/vrf-sidecar/node-client/vrfHandler.js vrf/
```

- [ ] **Step 2: Harden `.gitignore` against the untracked secrets**

Append these lines to `.gitignore`:

```
# VRF temp/extract
_vrf_extract/
# stray service-account / credential files (never commit)
whatsapp-bot-*.json
_temp_sa.json
_sa.json
```

- [ ] **Step 3: Verify the engine files are present and unchanged**

Run: `ls vrf-sidecar/engine` → expect `build_boq.py  engine.py  vrf_data.py`

- [ ] **Step 4: Commit (explicit paths only)**

```bash
git add vrf-sidecar/app.py vrf-sidecar/engine vrf-sidecar/requirements.txt \
        vrf-sidecar/Dockerfile vrf-sidecar/.env.example vrf-sidecar/README.md \
        vrf-sidecar/CLAUDE_CODE_BRIEF.md \
        vrf/vrfClient.js vrf/vrfIntake.js vrf/vrfHandler.js .gitignore
git commit -m "Add VRF sidecar (engine) and node client modules"
```

---

## Task 2: Install the xlsx dependency

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install SheetJS**

```bash
npm i xlsx
```

- [ ] **Step 2: Verify it resolves**

Run: `node -e "require('xlsx'); console.log('xlsx ok')"`
Expected: `xlsx ok`

- [ ] **Step 3: Confirm Node has global fetch (the client modules rely on it)**

Run: `node -e "console.log(typeof fetch)"`
Expected: `function`. If it prints `undefined`, STOP — add `node-fetch` and `const fetch = require('node-fetch')` to `vrf/vrfClient.js` and `vrf/vrfIntake.js` before continuing.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "Add xlsx (SheetJS) for VRF schedule intake"
```

---

## Task 3: Exact-phrase trigger matcher (TDD)

**Files:**
- Create: `vrf/trigger.js`
- Test: `vrf/trigger.test.js`

- [ ] **Step 1: Write the failing test**

`vrf/trigger.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { isVrfTrigger } = require('./trigger');

test('matches the exact phrase, case-insensitive, with surrounding whitespace', () => {
  assert.equal(isVrfTrigger('VRF Selection'), true);
  assert.equal(isVrfTrigger('vrf selection'), true);
  assert.equal(isVrfTrigger('  VRF   Selection  '), true);
});

test('does not match bare keyword or phrase inside a sentence', () => {
  assert.equal(isVrfTrigger('vrf'), false);
  assert.equal(isVrfTrigger('please run vrf selection now'), false);
  assert.equal(isVrfTrigger('vrf selector'), false);
  assert.equal(isVrfTrigger(''), false);
  assert.equal(isVrfTrigger(undefined), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test vrf/trigger.test.js`
Expected: FAIL — `Cannot find module './trigger'`.

- [ ] **Step 3: Write the minimal implementation**

`vrf/trigger.js`:

```js
// Exact-phrase trigger for the VRF Selection feature.
// Matches "VRF Selection" only (case-insensitive, ignoring outer/inner extra
// whitespace). Bare "vrf" and the phrase embedded in a longer message do NOT
// match — this is a hard product requirement.
function isVrfTrigger(text) {
  if (typeof text !== 'string') return false;
  return /^\s*vrf\s+selection\s*$/i.test(text);
}

module.exports = { isVrfTrigger };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test vrf/trigger.test.js`
Expected: PASS (2 tests, 0 failures).

- [ ] **Step 5: Commit**

```bash
git add vrf/trigger.js vrf/trigger.test.js
git commit -m "Add exact-phrase VRF Selection trigger matcher"
```

---

## Task 4: Make the reply text Drive-link-optional

**Files:**
- Modify: `vrf/vrfClient.js`

`summaryToWhatsApp(summary, driveLink)` currently always appends a "BOQ: <link>" line. Since we deliver the file directly, the link is optional.

- [ ] **Step 1: Make the link lines conditional**

In `vrf/vrfClient.js`, replace this block at the end of `summaryToWhatsApp`:

```js
  if (summary.flags && summary.flags.length) {
    lines.push(``, `Flags: ${summary.flags.join('; ')}`);
  }
  lines.push(``, `BOQ: ${driveLink}`);
  lines.push(`(Open the Prices tab to fill unit prices — totals repopulate automatically.)`);
  return lines.join('\n');
```

with:

```js
  if (summary.flags && summary.flags.length) {
    lines.push(``, `Flags: ${summary.flags.join('; ')}`);
  }
  if (driveLink) {
    lines.push(``, `BOQ: ${driveLink}`);
  }
  lines.push(``, `(Open the Prices tab to fill unit prices — totals repopulate automatically.)`);
  return lines.join('\n');
```

- [ ] **Step 2: Smoke-check the module still loads**

Run: `node -e "require('./vrf/vrfClient'); console.log('vrfClient ok')"`
Expected: `vrfClient ok`

- [ ] **Step 3: Commit**

```bash
git add vrf/vrfClient.js
git commit -m "VRF reply: make BOQ link optional (direct-document delivery)"
```

---

## Task 5: Dependency injection + direct-document delivery in vrfHandler

**Files:**
- Modify: `vrf/vrfHandler.js`

The provided handler has two stubs (`sendWhatsApp`, `uploadToDrive`). We inject the bot's real functions and deliver the xlsx as a document instead of a Drive link. This also avoids a circular require with `server.js`.

- [ ] **Step 1: Replace the stub block with injected deps**

In `vrf/vrfHandler.js`, replace this block:

```js
// ---- wire these to your existing bot functions -----------------------------
async function sendWhatsApp(userId, text) {
  // TODO: your existing send function
}
async function sendWhatsAppFileNote(userId, text) {
  // optional: same as sendWhatsApp
  return sendWhatsApp(userId, text);
}
async function uploadToDrive(buffer, filename) {
  // TODO: your existing service-account upload. Must return a shareable URL.
  // return 'https://drive.google.com/file/d/.../view';
}
// ----------------------------------------------------------------------------
```

with:

```js
// ---- injected by the bot via initVrf() -------------------------------------
// deps.sendText(userId, text)            -> outbound WhatsApp text
// deps.sendDocument(userId, buf, name)   -> outbound WhatsApp document (xlsx)
let deps = {
  sendText: async () => { throw new Error('VRF not initialized: call initVrf({ sendText, sendDocument })'); },
  sendDocument: async () => { throw new Error('VRF not initialized: call initVrf({ sendText, sendDocument })'); },
};
function initVrf(d) { deps = { ...deps, ...d }; }

async function sendWhatsApp(userId, text) {
  return deps.sendText(userId, text);
}
// ----------------------------------------------------------------------------
```

- [ ] **Step 2: Stamp a timestamp on the session for the bot's timeout sweep**

In `onVrfKeyword`, replace:

```js
  sessions.set(userId, { mode: 'vrf', guided, pending: null });
```

with:

```js
  sessions.set(userId, { mode: 'vrf', guided, pending: null, ts: Date.now() });
```

- [ ] **Step 3: Deliver the xlsx as a document instead of uploading to Drive**

Replace the whole `finishAndSend` function:

```js
async function finishAndSend(userId, input) {
  await sendWhatsApp(userId, 'Running selection...');
  const { xlsxBuffer, summary } = await runVrfSelection(input);
  const filename = `${(summary.project || 'VRF').replace(/[^\w]+/g, '_')}_VRF_BOQ.xlsx`;
  const driveLink = await uploadToDrive(xlsxBuffer, filename);
  await sendWhatsApp(userId, summaryToWhatsApp(summary, driveLink));
}
```

with:

```js
async function finishAndSend(userId, input) {
  await sendWhatsApp(userId, 'Running selection...');
  const { xlsxBuffer, summary } = await runVrfSelection(input);
  const filename = `${(summary.project || 'VRF').replace(/[^\w]+/g, '_')}_VRF_BOQ.xlsx`;
  await deps.sendDocument(userId, xlsxBuffer, filename);
  await sendWhatsApp(userId, summaryToWhatsApp(summary)); // no link: file sent directly
}
```

- [ ] **Step 4: Export `initVrf`**

Replace the export line:

```js
module.exports = { onVrfKeyword, onVrfMessage, sessions };
```

with:

```js
module.exports = { initVrf, onVrfKeyword, onVrfMessage, sessions };
```

- [ ] **Step 5: Smoke-check the module loads and exports**

Run: `node -e "const h=require('./vrf/vrfHandler'); console.log(['initVrf','onVrfKeyword','onVrfMessage','sessions'].every(k=>k in h) ? 'exports ok' : 'MISSING')"`
Expected: `exports ok`

- [ ] **Step 6: Commit**

```bash
git add vrf/vrfHandler.js
git commit -m "VRF handler: inject bot deps, deliver xlsx as WhatsApp document"
```

---

## Task 6: Bot helpers — inbound media download, buffer upload, document send

**Files:**
- Modify: `server.js` (add helpers near the existing media code, after `uploadMedia`, ~line 656)

- [ ] **Step 1: Add `downloadWhatsAppMedia`, `uploadMediaBuffer`, `sendDocument`**

Insert immediately after the `uploadMedia` function (it ends at `server.js:656`, just before `// Send a file found in the Drive folder`):

```js
// Download an inbound WhatsApp media object by its media id -> bytes.
// Two-step per Meta Cloud API: (1) GET the media metadata to obtain a short-
// lived URL, (2) GET that URL with the same bearer token.
async function downloadWhatsAppMedia(mediaId) {
  const meta = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const url = meta.data?.url;
  const mediaType = meta.data?.mime_type || "application/octet-stream";
  if (!url) throw new Error("media url not returned by WhatsApp");
  const bin = await axios.get(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: "arraybuffer",
    maxRedirects: 5,
  });
  return { buffer: Buffer.from(bin.data), mediaType };
}

// Upload a raw buffer (e.g. a generated xlsx) to WhatsApp media. Returns a media id.
// Buffer variant of uploadMedia (which downloads-then-uploads from Drive).
async function uploadMediaBuffer(buffer, filename) {
  const mime = mimeFromName(filename);
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mime });
  form.append("type", mime);
  const up = await axios.post(MEDIA_URL, form, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, ...form.getHeaders() },
  });
  return up.data.id;
}

// Send a generated buffer to a user as a WhatsApp document.
async function sendDocument(to, buffer, filename, caption) {
  const mediaId = await uploadMediaBuffer(buffer, filename);
  return send(to, {
    messaging_product: "whatsapp", to, type: "document",
    document: { id: mediaId, filename, caption: caption || "" },
  });
}
```

- [ ] **Step 2: Smoke-check the file still parses**

Run: `node -e "require('./server.js')" ` — Expected: it boots (prints `🚀 Listening on ...`). Press Ctrl-C. A syntax error would throw before listening.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "Bot: add WhatsApp media download, buffer upload, document send helpers"
```

---

## Task 7: Wire VRF into the webhook router

**Files:**
- Modify: `server.js` (requires near top ~line 16; webhook handler ~line 1039)

- [ ] **Step 1: Require the VRF modules and initialize them**

After `server.js:16` (`const { generateMtzPdf } = require("./mtz-pdf.js");`), add:

```js
const { isVrfTrigger } = require("./vrf/trigger.js");
const {
  initVrf, onVrfKeyword, onVrfMessage, sessions: vrfSessions,
} = require("./vrf/vrfHandler.js");
```

Then, after the `sendDocument` function is defined (Task 6), add the init call and a timeout constant. Put the constant next to the MTZ one at `server.js:90`:

```js
const VRF_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
```

And register the deps once at startup — add this line just above `app.listen(...)` at the end of the file (`server.js:1316`):

```js
initVrf({ sendText, sendDocument });
```

- [ ] **Step 2: Insert VRF routing into the webhook, before the text-only short-circuit**

In the webhook handler, find this line (`server.js:1040`):

```js
    if (message.type !== "text") return;
```

Insert the following block **immediately before** it:

```js
    // ── VRF Selection session (handles text, image, and document messages) ──
    if (vrfSessions.has(from)) {
      const s = vrfSessions.get(from);
      if (Date.now() - (s.ts || 0) > VRF_TIMEOUT_MS) {
        vrfSessions.delete(from);
        return await sendText(from, "⏰ VRF session timed out. Type *VRF Selection* to start again.");
      }
      s.ts = Date.now(); // refresh on activity

      const vText = message.type === "text" ? message.text.body.trim() : "";
      let attachment = null;
      try {
        if (message.type === "image" && message.image?.id) {
          const dl = await downloadWhatsAppMedia(message.image.id);
          attachment = { base64: dl.buffer.toString("base64"), mediaType: dl.mediaType, filename: "schedule.jpg" };
        } else if (message.type === "document" && message.document?.id) {
          const dl = await downloadWhatsAppMedia(message.document.id);
          attachment = {
            base64: dl.buffer.toString("base64"),
            mediaType: message.document.mime_type || dl.mediaType,
            filename: message.document.filename || "schedule",
          };
        }
      } catch (err) {
        console.error("❌ VRF media download error:", err.response?.data || err.message);
        return await sendText(from, "I couldn't download that file. Try again, or type the rows manually.");
      }

      await onVrfMessage(from, vText, attachment);
      return;
    }

    // ── VRF trigger: exact phrase "VRF Selection" only ──
    if (message.type === "text" && isVrfTrigger(message.text.body)) {
      return await onVrfKeyword(from);
    }

```

Note: this block sits **before** `if (message.type !== "text") return;`, so image/document messages reach the VRF handler. For non-VRF users, image/document messages still fall through to that early return unchanged.

- [ ] **Step 3: Smoke-check the file boots**

Run: `node -e "require('./server.js')"` — Expected: prints `🚀 Listening on ...` with no error. Ctrl-C.

- [ ] **Step 4: Re-run the trigger unit test (regression)**

Run: `node --test vrf/trigger.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "Wire VRF Selection into the webhook router (exact-phrase trigger + media routing)"
```

---

## Task 8: Local end-to-end test of the sidecar

Verifies the engine + FastAPI wrapper before deploying. Uses the local Python 3.14.

**Files:** none (runtime verification only)

- [ ] **Step 1: Create a venv and install sidecar deps**

```bash
cd vrf-sidecar
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
```

- [ ] **Step 2: Run the sidecar locally with a key, in the background**

```bash
VRF_API_KEY=localtestkey .venv/Scripts/python -m uvicorn app:app --host 127.0.0.1 --port 8099
```
(Windows PowerShell: `$env:VRF_API_KEY="localtestkey"; .venv\Scripts\python -m uvicorn app:app --host 127.0.0.1 --port 8099`)

- [ ] **Step 3: Health check**

Run: `curl -s http://127.0.0.1:8099/health`
Expected: `{"ok":true}`

- [ ] **Step 4: Auth check (no key -> 401)**

Run: `curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:8099/select -H "Content-Type: application/json" -d '{"project":"T","rows":[{"type":"ducted","required_kw":6,"qty":1,"system":"S1"}]}'`
Expected: `401`

- [ ] **Step 5: Valid selection -> xlsx + summary header**

```bash
curl -s -D - -o /tmp/vrf_test.xlsx -X POST http://127.0.0.1:8099/select \
  -H "Content-Type: application/json" -H "X-API-Key: localtestkey" \
  -d '{"project":"Test","discount":0.25,"rows":[{"type":"ducted","required_kw":6,"qty":2,"system":"S1"},{"type":"4 way cassette","required_kw":14,"qty":4,"system":"S2"}]}'
```
Expected: response headers include `content-type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and an `x-summary: {...}` JSON header; `/tmp/vrf_test.xlsx` is a valid (non-empty, PK-signature) xlsx. Confirm: `head -c 2 /tmp/vrf_test.xlsx` → `PK`.

- [ ] **Step 6: Stop the local sidecar** (Ctrl-C on its terminal). No commit (no files changed).

---

## Task 9: Deploy the sidecar on Render + set env vars (manual dashboard)

**Files:** none (infra). These are manual steps the user performs in the Render dashboard; the agent prepares the values.

- [ ] **Step 1: Generate the shared API key**

Run: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
Save the output as `VRF_API_KEY` (used on BOTH services).

- [ ] **Step 2: Push the branch so Render can see the sidecar folder**

```bash
git push -u origin feat/vrf-selection
```
(Merge to the deploy branch per the repo's normal flow before/after acceptance — see Task 11.)

- [ ] **Step 3: Create the sidecar service (user, in Render dashboard)**
  - New → Web Service → connect `uetian78/whatsapp-bot`.
  - Runtime: **Docker**. Root Directory: `vrf-sidecar`. Region: **same as the bot**.
  - Plan: Free. Env var: `VRF_API_KEY` = the value from Step 1.
  - Create. Note the URL, e.g. `https://vrf-sidecar-xxxx.onrender.com`.

- [ ] **Step 4: Verify the deployed sidecar**

Run: `curl -s https://<sidecar-host>/health`
Expected: `{"ok":true}` (first call may take ~30–50s on the free tier — cold start).

- [ ] **Step 5: Set the bot's env vars (user, in Render → the Node bot service)**
  - `VRF_SIDECAR_URL` = the sidecar URL from Step 3 (no trailing slash).
  - `VRF_API_KEY` = same value as Step 1.
  - `ANTHROPIC_API_KEY` = (already set; confirm present).
  - Trigger a redeploy of the bot so it picks up the new env + code.

---

## Task 10: WhatsApp acceptance tests (manual, end to end)

**Files:** none (acceptance). Run against the deployed bot from a colleague's WhatsApp.

- [ ] **Step 1: Trigger** — Send `VRF Selection`. Expect the intro prompt; no other flow (MTZ etc.) reacts.
- [ ] **Step 2: Non-trigger** — Send `vrf` and `please run vrf selection now`. Expect neither starts a VRF session.
- [ ] **Step 3: Typed flow** — `VRF Selection` → project name → `4 way cassette | 5 | 1 | S1 | Office` → `done`. Expect a `..._VRF_BOQ.xlsx` document + summary text.
- [ ] **Step 4: xlsx upload** — `VRF Selection` → upload a schedule .xlsx. Expect the document + summary, no yes/no step.
- [ ] **Step 5: Image/PDF** — `VRF Selection` → send a photo/PDF of a schedule. Expect "Reading the schedule..." → a confirmation (counts + sample rows) → reply `yes` → document + summary. Repeat and reply `no` → cancel message.
- [ ] **Step 6: Timeout** — Start a session, wait >10 min, send a message. Expect the timeout message.
- [ ] **Step 7: Two users** — Two colleagues run flows concurrently; confirm sessions don't cross.

---

## Task 11: Finish the branch

- [ ] **Step 1: Confirm all unit tests pass**

Run: `node --test vrf/trigger.test.js`
Expected: PASS.

- [ ] **Step 2: Confirm no secrets staged**

Run: `git status --porcelain` — confirm none of `whatsapp-bot-*.json`, `_temp_sa.json`, `_vrf_extract/` are tracked/staged.

- [ ] **Step 3: Integrate** per repo norm (open a PR `feat/vrf-selection` → `main`, or merge). Use the superpowers:finishing-a-development-branch skill to decide.

---

## Self-Review notes

- **Spec coverage:** trigger (T3,T7), two-service architecture (T1,T8,T9), direct xlsx delivery (T5,T6), all three intake paths (handled by used-as-is `vrfIntake.js` + media routing T7), session isolation + timeout (T5,T7), env vars (T9), sidecar fail-closed (engine `app.py` used as-is), testing (T8,T10). ✓
- **No new prices / engine unchanged:** `vrf-sidecar/engine/*` and `app.py` are copied verbatim (T1) and never edited. ✓
- **Type consistency:** `initVrf`/`onVrfKeyword`/`onVrfMessage`/`sessions`(as `vrfSessions`) exported in T5 and consumed in T7; `downloadWhatsAppMedia`→`{buffer,mediaType}`, `sendDocument(to,buffer,filename)`, `uploadMediaBuffer(buffer,filename)` defined T6 and used T7; `isVrfTrigger` defined T3 used T7. ✓
