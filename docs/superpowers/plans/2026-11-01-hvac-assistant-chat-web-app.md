# HVAC Assistant Chat Web App Implementation Plan (3-person version)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the live bot's security gaps, make the Drive PDFs searchable, and ship a chat-style phone web app for 3 people that can share a file or a single page to WhatsApp.

**Architecture:** `server.js` and its existing `if` chain stay. The smallest possible change makes them channel-neutral: replies go through a send facade, and the web app delivers messages in the same shape the WhatsApp webhook uses. A SQLite file holds conversations and state, a second one holds PDF page text, and Google Sheets stays the place people edit and read.

**Tech Stack:** Node 24 (CommonJS), Express 4, built-in `node:sqlite` with FTS5, `node:test`, `@anthropic-ai/sdk` 1.x, `pdfjs-dist` 4.10.38, `qpdf` and `poppler-utils`, plain HTML, CSS and JavaScript for the screen.

**Spec:** `docs/superpowers/specs/2026-11-01-hvac-assistant-rebuild-design.md`

**Scope:** The user and 2 others. Left out on the user's decision: the route table rewrite, merging the document searches, the webhook signature check (WhatsApp is switched off instead), plain-English requests, logging fixes, the Sonnet comparison and the Business app greeting.

## Global Constraints

- Never run `git add -A` or `git add .`; the repo root holds credential files. Add named files, or the new code folders by name.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Push to `main` only after the user says so; pushing deploys to Railway.
- Never log tokens, PINs, cookies or document text.
- Do not change `vrf/`, `vrf-sidecar/`, `split-engine.js`, `split-pdf.js`, `mtz-engine.js`, `chillers.js` selection logic, or the `PRODUCTS` data and matching functions.
- Every capacity and spec comes from the engines, product data or cited document pages, never from the AI's memory.
- Text AI uses `claude-haiku-5-5`. Photo and PDF reading stays on `claude-sonnet-4-6`.
- On Haiku 5.5, read replies by block `type`, never `content[0]`. Send no `temperature`, `top_p` or `top_k`. Thinking counts toward `max_tokens`, so use at least 1024 and set effort with `output_config`, not `thinking: disabled`.
- Prices are never stored.
- Scanned PDF pages are not read by AI. Those files are found by file name only.
- Hosting is Railway Free: 0.5 GB memory, 0.5 GB volume, 1 vCPU, 4 GB image, $1 of credit a month, Serverless on. Never hold a whole Drive PDF in memory on a web path, and no idle timer may make network calls, so the app can sleep.
- The product name is `HVAC Assistant`. Do not put Mannai's name on new screens or menus unless Mannai approves.
- No unofficial WhatsApp libraries, and no general-purpose AI chat.
- New dependencies allowed: `pdfjs-dist@4.10.38`, `@anthropic-ai/sdk@^1.3.0`, SheetJS `xlsx` from its own CDN. Use `node:sqlite` and `node:test` for the rest.
- `DATA_DIR` holds the databases and generated files. It defaults to `~/.hvac-assistant`, because the repo sits in OneDrive and synced folders can corrupt SQLite. Railway uses a volume mounted at `/data`.
- WhatsApp stays off unless `WHATSAPP_ENABLED=true`. Before anyone turns it on, the webhook signature check must be added.

## Review Focus

- A chat app previews an invite link before the person taps it: the preview must not sign anyone in (test in Task 13).
- A 12 MB phone photo, an HEIC photo or a wrong file type: the person gets a clear message and nothing crashes (tests in Tasks 14 and 15).
- A redeploy or app sleep in the middle of a flow, including while a schedule is being read: the person can carry on (test in Task 6).
- Odd characters in a search, such as `"`, `*`, `APMR-A (T3)` or `AND`: results or "nothing found", never an error (test in Task 9).
- A person removed from the Allowed tab, or a Sheet that can't be read: no access, no crash, no open door (tests in Tasks 1 and 13).

---

## File Structure

```
server.js                 Stays the router; gains a channel wrapper and web mount
lib/app-config.js         whatsappEnabled, requiredEnv
lib/http-auth.js          Admin login check
lib/channel.js            Per-request channel and the send facade
lib/channel-whatsapp.js   Adapter over lib/wa.js
lib/channel-web.js        Adapter that writes to conversations
lib/db.js                 Opens SQLite, runs migrations
lib/ai.js                 Text AI calls, usage, spending cap
lib/control-sheet.js      Allowed numbers and Knowledge, keeping the last good copy
lib/conversations.js      Chat messages and generated files
lib/page-index.js         PDF page text storage and search
lib/pdf-text.js           Text from a PDF, page by page
lib/pdf-worker.js         Child process that reads one PDF
lib/page-extract.js       One page as a PDF or image
lib/answers.js            Answers with page references
scripts/build-index.js    Reads all PDFs on the PC and uploads the search file
scripts/make-invite.js    Prints a personal sign-in link
web/auth.js               Invite links and session cookies
web/routes.js             Chat API, files, uploads, share links
web/public/               index.html, app.js, render.js, styles.css, manifest, icons
tests/replay/             Replay of the real message log
```

## Part A: Safety fixes

Ships on its own from branch `fix/safety`.

### Task 1: Lock admin pages, check the sender first, switch WhatsApp off

**Files:**
- Create: `lib/http-auth.js`, `lib/app-config.js`
- Modify: `lib/accounts.js`, `lib/doc-requests.js`, `server.js`, `.env.example`
- Test: `tests/http-auth.test.js`, `tests/app-config.test.js`, `tests/accounts.test.js`, `tests/doc-requests.test.js`

**Interfaces:**
- Produces: `requireAdmin(env = process.env): ExpressMiddleware`; `whatsappEnabled(env): boolean`; `requiredEnv(env): string[]`; `findAccount(from: string, accounts: Map): Account|null`; `isAdmin(from: string, env = process.env): boolean`

- [ ] **Step 1: Write the failing tests**

```js
test("requireAdmin: none or wrong password 401 with WWW-Authenticate Basic; right password next(); ADMIN_PASSWORD unset 503");
test("WhatsApp is on only when WHATSAPP_ENABLED is exactly true", () => {
  assert.equal(whatsappEnabled({ WHATSAPP_TOKEN: "x" }), false);
  assert.equal(whatsappEnabled({ WHATSAPP_ENABLED: "true" }), true);
});
test("required env without WhatsApp", () => assert.deepEqual(requiredEnv({}), ["GOOGLE_SHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON"]));
test("required env with WhatsApp adds its three settings");
test("findAccount matches digits only", () => assert.equal(findAccount("+974 5555 5555", accounts).number, "97455555555"));
test("an empty Allowed list lets nobody in", () => assert.equal(findAccount("97455555555", new Map()), null));
test("isAdmin uses ADMIN_NUMBERS, else the default admin; others are refused", () => {
  assert.equal(isAdmin("97411111111", { ADMIN_NUMBERS: "97411111111" }), true);
  assert.equal(isAdmin("97466279059", {}), true);
  assert.equal(isAdmin("97422222222", {}), false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/http-auth.test.js tests/app-config.test.js tests/accounts.test.js tests/doc-requests.test.js`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement and wire in**

Put `requireAdmin` on `/drive-index` and `/vrf-health`, comparing with `crypto.timingSafeEqual`. Mount `/webhook`, `/api/sender` and number health only when `whatsappEnabled`, and use `requiredEnv` for the startup check. In the webhook's `enqueue`, return right after `loadSheet()` when `findAccount` gives null, and send the crash apology only when an account was found. Remove the later Allowed check in `handleIncomingMessage`. `stats` uses `isAdmin`. Add `ADMIN_PASSWORD`, `ADMIN_NUMBERS` and `WHATSAPP_ENABLED` to `.env.example`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/http-auth.js lib/app-config.js lib/accounts.js lib/doc-requests.js server.js .env.example tests/http-auth.test.js tests/app-config.test.js tests/accounts.test.js tests/doc-requests.test.js
git commit -m "fix(security): lock admin pages and switch WhatsApp off by default"
```

### Task 2: Fix dependencies and Docker exclusions

**Files:**
- Create: `scripts/check-google.js`
- Modify: `package.json`, `package-lock.json`, `.dockerignore`, `.gitignore`
- Test: `tests/xlsx-smoke.test.js`

**Interfaces:**
- Produces: `node scripts/check-google.js` prints `Google OK: <n> files, Sheet readable`. It only reads.

- [ ] **Step 1: Write the smoke test**

```js
test("xlsx reads back a workbook it wrote", () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Room", "kW"], ["A", 5]]), "S");
  const back = XLSX.read(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  assert.equal(back.Sheets.S.B2.v, 5);
});
```

- [ ] **Step 2: Update packages**

Run: `npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, then `npm install axios@latest form-data@latest`, then `npm audit fix`.
Then try `npm install googleapis@latest`. Keep it only if `node scripts/check-google.js` still passes; otherwise restore version 144 and record the remaining moderate `uuid` issue in the commit message.

- [ ] **Step 3: Update ignore files**

Add `whatsapp-bot-*.json`, `_temp_sa.json`, `_sa.json` and `data/` to `.dockerignore`. Add `data/` and `tests/replay/*.local.json` to `.gitignore`.

- [ ] **Step 4: Verify**

Run: `npm test` and `npm audit --omit=dev`
Expected: tests pass, with no critical or high issues.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .dockerignore .gitignore scripts/check-google.js tests/xlsx-smoke.test.js
git commit -m "fix(deps): replace vulnerable xlsx and update packages"
```

### Task 3: Phone sharing test, then ship Part A

**Files:**
- Create: `web/public/share-test.html`
- Modify: `server.js`

**Interfaces:**
- Produces: public `GET /share-test` (the page) and `GET /share-test.pdf` (one generated page). Task 17 removes both.

- [ ] **Step 1: Add the page**

One button. It fetches the PDF, builds a `File`, checks `navigator.canShare({ files })`, calls `navigator.share`, and prints the outcome on screen.

- [ ] **Step 2: Ask the user to set Railway variables and approve the push**

The user sets `ADMIN_PASSWORD` and `ADMIN_NUMBERS`. Generate `ADMIN_PASSWORD` into `.env` for them to copy, never in chat. Tell them this turns the WhatsApp route off, which the Meta lock has already stopped working.

- [ ] **Step 3: Verify the live service**

Run: `curl -s -o /dev/null -w "%{http_code}" <bot-url>/drive-index`, and the same with `-X POST <bot-url>/webhook`
Expected: `401`, then `404`.

- [ ] **Step 4: Ask the user to test on their phones**

Open `<bot-url>/share-test` and tap the button. Record per phone whether WhatsApp appears and whether the PDF arrives, in the spec under "Check first". If WhatsApp doesn't appear on a phone, Task 15's link fallback becomes that phone's main path.

- [ ] **Step 5: Commit**

```bash
git add web/public/share-test.html server.js docs/superpowers/specs/2026-11-01-hvac-assistant-rebuild-design.md
git commit -m "test: add phone sharing check page and record results"
```

## Part B: Core and searchable PDFs

Work on branch `feat/chat-web-app`, created from `main` after Part A.

### Task 4: Replay the real message log

**Files:**
- Create: `tests/replay/export-log.js`, `tests/replay/harness.js`, `tests/replay/capture-baseline.js`, `tests/replay/diff.js`, `tests/replay/replay.test.js`
- Modify: `server.js` (export `handleIncomingMessage`; listen only when `require.main === module`), `package.json` (test script adds `tests/replay/*.test.js` and the root scripts `test-brand-docs.js`, `test-catalogue-map.js`, `test-find-files-by-name.js`, `test-related-files.js`, `test-schedule-select.js`, which pass today but `npm test` never runs. Name them; `test-creds.js` must stay out)

**Interfaces:**
- Produces: `createHarness(deliver: (value, message) => Promise<void>): { send(user: string, logged: string): Promise<Outbound[]> }`, where `Outbound = { kind, text?, options?: string[], file?: string }`
- Produces: `node tests/replay/diff.js` prints counts of `files lost`, `new not-found` and `text changed`, then lists the first 20 of each

- [ ] **Step 1: Export the fixtures**

`export-log.js` reads the CRM log, the control Sheet and the Drive list into `messages.local.json`, `sheet.local.json` and `drive.local.json`. Phone numbers become `100000001`, `100000002` and so on, and names are dropped. These files stay out of git.

- [ ] **Step 2: Build the harness**

Before requiring `server.js`, overwrite exports with recording stubs: `lib/wa.js` senders, `lib/google.js` `getSheets`, `lib/drive-index.js` `listFolderFiles`, `crm.js`, `schedule-select.js` `rowsFromScheduleImage`, and the VRF client and intake. Set dummy env and no Anthropic key. A logged `btn:<title>` becomes a tap on the matching option from that user's last reply, or is recorded as a stale tap if none matches. `[image]` and `[document]` become fake media.

- [ ] **Step 3: Capture the baseline**

Run: `node tests/replay/capture-baseline.js`
Expected: `baseline.local.json` covers all 949 messages.

- [ ] **Step 4: Write the replay test and run it**

```js
test("replay matches baseline", { skip: !fixturesExist }, async () => {
  assert.deepEqual(await replayAll(), baseline);
});
```

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/replay/export-log.js tests/replay/harness.js tests/replay/capture-baseline.js tests/replay/diff.js tests/replay/replay.test.js server.js package.json
git commit -m "test: replay the real message log against the bot"
```

### Task 5: Send facade

**Files:**
- Create: `lib/channel.js`, `lib/channel-whatsapp.js`
- Modify: `server.js`
- Test: `tests/channel.test.js`

**Interfaces:**
- Produces: `runWithChannel(adapter, fn)`, `currentChannel()`, `supports(feature: string): boolean`, `downloadMedia(id): Promise<{ buffer, mediaType }>`, `showTyping(messageId)`, and `sendText(to, body)`, `sendLongText(to, body)`, `sendButtons(to, text, buttons)`, `sendList(to, text, label, rows)`, `sendDriveFile(to, file)`, `sendPdfBuffer(to, buffer, filename, caption)`, `sendDocument(to, buffer, filename, caption)`, all returning promises
- Produces: adapter contract `{ name, supports, typing, downloadMedia, text, longText, buttons, list, driveFile, generatedFile }`; `whatsappAdapter`

- [ ] **Step 1: Write the failing tests**

```js
test("sendText reaches the adapter in context");
test("two concurrent channels never cross", async () => { /* interleaved awaits, each records only its own */ });
test("sending outside a channel throws", () => assert.rejects(sendText("u", "x")));
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/channel.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement and switch `server.js`**

Use `AsyncLocalStorage`, as `lib/accounts.js` does. `server.js` imports the send functions from `lib/channel.js`, wraps handling in `runWithChannel(whatsappAdapter, ...)`, passes the facade to `initVrf`, and uses `downloadMedia` and `showTyping` in place of `downloadWhatsAppMedia` and `markReadWithTyping`. Remove the Sheet keyword rules (`matchRule`, `sendRule` and the `Rules` read in `loadSheet`, with its cache check changed to use `cache.ts`): their file links are all empty, and they call WhatsApp directly. Leave the `Rules` tab in the Sheet untouched.

- [ ] **Step 4: Run and review the replay**

Run: `npm test` and `node tests/replay/diff.js`
Expected: unit tests pass, and only messages that hit a keyword rule change, with `files lost: 0`. Recapture the baseline.

- [ ] **Step 5: Commit**

```bash
git add lib/channel.js lib/channel-whatsapp.js server.js tests/channel.test.js
git commit -m "refactor: send replies through a channel facade"
```

### Task 6: Database and restart-safe conversation state

**Files:**
- Create: `lib/db.js`
- Modify: `lib/session-store.js`, `server.js`
- Test: `tests/db.test.js`, `tests/session-store.test.js`

**Interfaces:**
- Produces: `openDb(path?: string): DatabaseSync` runs numbered migrations once, with WAL on; `getDb(): DatabaseSync`; `createSessionStore({ db, now }): Store`, whose methods match today's exports plus `persist(from: string): void` and `restore(): void`. The module's default exports keep working on a default store.
- Produces: `deliverMessage(value, message, adapter): Promise<void>` in `server.js` (queue, Allowed check, channel, apology, then `persist`). Task 14 receives it by injection.

- [ ] **Step 1: Write the failing tests**

```js
test("migrations run once", () => { const d = openDb(":memory:"); assert.equal(migrate(d), 0); });
test("a flow and its later edits survive a restart", () => {
  const a = createSessionStore({ db });
  const s = a.startFlow("u", "split", { step: "brand" }); s.step = "condition"; a.persist("u");
  const b = createSessionStore({ db }); b.restore();
  assert.equal(b.getFlow("u").data.step, "condition");
});
test("expired entries are not restored");
test("a schedule flow stuck on processing restarts at awaitImage", () => {
  // persisted { type: "schedule", data: { step: "processing" } } restores with step "awaitImage"
});
test("ctx values round-trip as JSON");
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/db.test.js tests/session-store.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

The Maps stay the working copy. `persist` writes that user's flow and ctx to table `user_state(user, key, value, expires_at)`, using keys `flow` and `ctx:<name>`. `restore` runs at startup. VRF sessions stay in memory, because `vrf/` is untouched.

- [ ] **Step 4: Verify**

Run: `npm test`
Expected: PASS, with the old session tests and the replay unchanged.

- [ ] **Step 5: Commit**

```bash
git add lib/db.js lib/session-store.js server.js tests/db.test.js tests/session-store.test.js
git commit -m "feat: keep conversations through restarts"
```

### Task 7: Newer AI model, no plans, no permission prompts

**Files:**
- Create: `lib/ai.js`
- Modify: `package.json`, `lib/db.js`, `lib/accounts.js`, `lib/ai-credits.js`, `lib/broad-search.js`, `lib/doc-requests.js`, `server.js`
- Test: `tests/ai.test.js`, `tests/accounts.test.js`, `tests/ai-credits.test.js`, `tests/doc-requests.test.js`

**Interfaces:**
- Produces: `createAi({ client, db, now, capUsd }): Ai`, with `Ai = { available(): boolean, spendThisMonth(): number, askText({ purpose, system, user, maxTokens = 1024, effort = "low" }): Promise<string|null>, askMessage(params): Promise<Message|null> }`; `textOf(message): string`
- Migration adds `ai_usage(ts, purpose, model, input, output, cache_read, cache_write, cost_usd)`

- [ ] **Step 1: Write the failing tests**

```js
test("textOf skips thinking blocks", () => assert.equal(
  textOf({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: "hi" }] }), "hi"));
test("cost uses the published rates", () => {
  // claude-haiku-5-5, 1M input and 1M output, costs 0.10 + 0.50 = 0.60
});
test("the monthly cap blocks calls, and a new month resets it");
test("refusal, max_tokens with no text, and API errors return null without throwing");
test("no plan gating remains: aiAllowed and freePlanMessage are gone");
test("the no-AI messages never mention a PAID plan or credits");
test("request wording makes no time promise", () => {
  assert.equal(REQUEST_BUTTON.title, "📥 Request it");
  assert.doesNotMatch(confirmText("x") + REQUEST_PROMPT + duplicateText("x"), /minute/i);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/ai.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Upgrade to `@anthropic-ai/sdk@^1.3.0`. Text defaults to `process.env.AI_TEXT_MODEL || "claude-haiku-5-5"`, and the cap to `Number(process.env.AI_MONTHLY_CAP_USD || 10)`. Rates per million tokens, in and out: `claude-haiku-5-5` 0.10 and 0.50. Cache reads cost 0.1x input and 5-minute cache writes 1.25x. Replace each `anthropic.messages.create` in `server.js` with `Ai`. The cap covers text AI only; photo reading stays in `schedule-select.js` and `vrf/`, uncounted. Leave `lib/sender-polish.js` alone, because Bot Sender is off.

Remove `aiAllowed`, `freePlanMessage`, `aiSearchConsented`, the `aiask` and `aiok` state, and the `aiyes` and `aino` taps. After the free scan misses, AI search runs by itself when `ai.available()`. Keep `isCreditError`, `isAiUnavailableError`, `markExhausted` and `aiFeatureUnavailableMessage`, because `vrf/` imports them.

New copy:
- `Reading images and schedules is paused right now. You can still get any document by its name.`
- `AI answers are paused right now. You can still get any document by its name.`
- `📥 Can't find it? Tap *Request it* and we'll add it to the library.`
- `✅ Request sent for *"<query>"*. We'll add it to the library as soon as we can.`

- [ ] **Step 4: Run and review the replay**

Run: `npm test` and `node tests/replay/diff.js`
Expected: tests pass. The diff shows only permission prompts and plan and request wording changing, with `files lost: 0`. Recapture the baseline.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json lib/ai.js lib/db.js lib/accounts.js lib/ai-credits.js lib/broad-search.js lib/doc-requests.js server.js tests/ai.test.js tests/accounts.test.js tests/ai-credits.test.js tests/doc-requests.test.js
git commit -m "feat(ai): move to Haiku 5.5 with a monthly cap, removing plans and prompts"
```

### Task 8: Saved library list

**Files:**
- Modify: `lib/drive-index.js`, `lib/db.js`, `server.js`
- Test: `tests/library-index.test.js`

**Interfaces:**
- Produces: `createLibraryIndex({ db, getDrive, folderId, now, staleMs = 600000 }): { list(): Promise<File[]>, refresh(): Promise<{ added, changed, removed }>, findById(id): File|null, onRefresh(fn) }`, with `File = { id, name, folder, exportMime?, mimeType, size, md5 }`
- `listFolderFiles()` keeps its signature on the default instance. Migration adds `library_files`.

- [ ] **Step 1: Write the failing tests**

```js
test("first call crawls and saves; a new instance reads the saved list without crawling");
test("a stale list returns at once and refreshes in the background, one refresh at a time");
test("a failed refresh keeps the old list");
test("refresh reports added, changed by md5, and removed");
test("Google Docs keep their export extension and exportMime");
test("refresh logs a count, not every file name");
test("no refresh runs unless someone asks for the list");
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/library-index.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Crawl fields add `size, md5Checksum, modifiedTime`. The list refreshes only when requested, never on a timer, so the app can sleep. Keep the Drive ID cache files as they are.

- [ ] **Step 4: Verify**

Run: `npm test`
Expected: PASS, including `replay matches baseline`.

- [ ] **Step 5: Commit**

```bash
git add lib/drive-index.js lib/db.js server.js tests/library-index.test.js
git commit -m "feat(library): keep the file list so waking up is quick"
```

### Task 9: Read and index the PDFs

**Files:**
- Create: `lib/pdf-text.js`, `lib/pdf-worker.js`, `lib/page-index.js`, `scripts/build-index.js`
- Modify: `package.json`, `server.js`
- Test: `tests/page-index.test.js`

**Interfaces:**
- Produces: `extractPages(data: Uint8Array): Promise<string[]>`
- Produces: `createPageIndex({ db, readFile, maxBytes }): { sync(files: File[]): void, runNext(): Promise<boolean>, search(query, { limit = 8, docType = null }): PageHit[], status(): { total, indexed, noText, tooLarge, failed, pages, emptyPages } }`, with `PageHit = { fileId, name, folder, page, snippet, size }`
- Produces: `readFileInWorker(file): Promise<string[]>`, which runs `lib/pdf-worker.js` as a child process
- Produces: `node scripts/build-index.js [--no-upload]` reads every PDF on the user's PC into `search.db`, then uploads it to `POST /admin/search-index` (behind `requireAdmin`), which swaps it in

- [ ] **Step 1: Write the failing tests**

Build the PDFs in the test with `pdfkit`.

```js
test("finds text on the right page", async () => {
  // two-page PDF with "compressor" on page 2
  assert.equal(index.search("compressor")[0].page, 2);
});
test("a PDF with no text is marked noText, not failed");
test("a changed md5 replaces the old pages; a removed file's pages disappear");
test("a file over maxBytes is marked tooLarge and never read");
test("an uploaded search.db replaces the old one and search keeps working");
test("a bad upload leaves the old search.db in place");
test("a worker crash marks that file failed and the next file still runs");
test("indexing resumes after a restart where it stopped");
test("odd search text returns results or [] and never throws", () => {
  for (const q of ['"', "*", "APMR-A (T3)", "AND", "NEAR(", "-", "'; DROP"]) assert.ok(Array.isArray(index.search(q)));
});
test("docType limits results by folder");
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/page-index.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Install `pdfjs-dist@4.10.38`. Load `pdfjs-dist/legacy/build/pdf.mjs` by dynamic `import()`, with `disableFontFace: true, useSystemFonts: false, isEvalSupported: false, verbosity: 0`. A page under 20 characters counts as empty. Keep `doc_files(id, md5, status, pages, empty_pages, error, indexed_at)` and FTS5 `doc_pages(name, folder, body, file_id UNINDEXED, page UNINDEXED)` in their own file, `DATA_DIR/search.db`. Quote each word from `meaningfulTokens` for the query, try all words first, then any word. Order by `bm25(doc_pages, 5, 1, 1)`.

Fork one child per file with `--max-old-space-size` from `PDF_WORKER_MEMORY_MB`, default 256, and a 180-second limit. On the server, `maxBytes` comes from `PDF_INDEX_MAX_MB`, default 10; larger new or changed files wait as tooLarge for the next PC run. `scripts/build-index.js` has no size limit and gives each worker 2048 MB. Register `sync` with `onRefresh`, and work through the queue one file at a time.

- [ ] **Step 4: Run to verify they pass, then try the real library**

Run: `npm test`, then `node scripts/build-index.js --no-upload` with the real `.env`, and print `status()`.
Expected: tests pass. All 518 PDFs end as indexed, noText or failed, any failures are listed, and `search.db` is under 300 MB.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json lib/pdf-text.js lib/pdf-worker.js lib/page-index.js scripts/build-index.js server.js tests/page-index.test.js
git commit -m "feat(library): read the Drive PDFs and search their pages"
```

### Task 10: Show page results and answer from pages

**Files:**
- Create: `lib/answers.js`
- Modify: `lib/channel.js`, `lib/channel-whatsapp.js`, `server.js`
- Test: `tests/answers.test.js`, `tests/page-search-route.test.js`

**Interfaces:**
- Consumes: `index.search`, `Ai.askMessage`
- Produces: `sendPageHits(to, prompt, hits): Promise<boolean>` on the facade, and adapter method `pageHits`; `answerFromLibrary(question, { ai, search, knowledge }): Promise<{ text, sources: { fileId, name, page }[] }|null>`; `runLibrarySearch(to, text, files)` in `server.js`

- [ ] **Step 1: Write the failing tests**

```js
test("find sound level returns page results", () => { /* message "find sound level" */ });
test("search all still means the existing command");
test("a file-name hit is sent as before, without page results");
test("when file names miss, page results come first, then close file names");
test("the answer lists the cited documents and pages", async () => {
  // fake AI text block with citations document_index 0
  assert.deepEqual(r.sources[0], { fileId: "f1", name: "APMR-A", page: 14 });
});
test("NO_ANSWER falls through to document search");
test("with AI unavailable, the person still gets the page results");
test("a question with no matching pages uses only PRODUCT_KB and Knowledge");
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/answers.test.js tests/page-search-route.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Messages matching `/^(find|search)\s+(.+)/i`, checked after `search all`, go to `runLibrarySearch`. `sendNotFoundWithSuggestions` and the series-with-extra-words branch call it too. Send the top 5 pages to Haiku as `document` blocks: `source: { type: "text", media_type: "text/plain", data }`, `title: "<name> p.<page>"`, `citations: { enabled: true }`. Do not combine this with `output_config.format`. Instruct the model to answer only from `PRODUCT_KB`, Knowledge and these pages, and to reply exactly `NO_ANSWER` otherwise. Admin `stats` adds one line from `status()`.

- [ ] **Step 4: Run and review the replay**

Run: `npm test` and `node tests/replay/diff.js`
Expected: tests pass with `files lost: 0`. Recapture the baseline.

- [ ] **Step 5: Commit**

```bash
git add lib/answers.js lib/channel.js lib/channel-whatsapp.js server.js tests/answers.test.js tests/page-search-route.test.js
git commit -m "feat(search): search inside PDFs and answer with page references"
```

### Task 11: Get just the matching page

**Files:**
- Create: `lib/page-extract.js`
- Modify: `lib/google.js`, `server.js`, `lib/channel-whatsapp.js`, `Dockerfile`
- Test: `tests/page-extract.test.js`

**Interfaces:**
- Consumes: `PageHit`, `createLibraryIndex().findById`, `sendDocument(to, buffer, filename, caption)`
- Produces: `streamDriveFile(fileId): Promise<Readable>` in `lib/google.js`; `createPageExtractor({ run, stream, dataDir, now }): { getPage({ file, page, format: "pdf"|"image" }): Promise<{ buffer, filename }> }`; tap `page|<fileId>|<n>|pdf` and `page|<fileId>|<n>|image`

- [ ] **Step 1: Write the failing tests**

```js
test("the PDF job asks qpdf for one page", () => assert.deepEqual(args, ["--empty", "--pages", src, "14", "--", out]));
test("the image job asks pdftoppm for one page at 150 dpi", () => assert.deepEqual(args,
  ["-f", "14", "-l", "14", "-singlefile", "-r", "150", "-jpeg", src, outBase]));
test("the file name is <file name> - page 14.pdf, or .jpg for an image");
test("a page outside the file gets: That page isn't in this file.");
test("a file id not in the library is refused");
test("the same page of the same file version comes from the cache with no download");
test("a changed md5 gets a fresh page");
test("only one page job runs at a time");
test("a failed or timed-out job gets: Couldn't get that page. Open the full file instead. and temp files are removed");
test("the download goes to a temp file through a stream, never one big Buffer");
test("real tools make a one-page PDF and a JPEG", { skip: !toolsInstalled });
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/page-extract.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `qpdf` and `poppler-utils` to the `apt-get install` line in `Dockerfile`. `streamDriveFile` calls `https://www.googleapis.com/drive/v3/files/<id>?alt=media&supportsAllDrives=true` with axios `responseType: "stream"` and `getGoogleAccessToken()`. Jobs run through `spawn` with a 60-second limit. Temp files go in `os.tmpdir()`. The cache is `DATA_DIR/page-cache`, capped at 100 MB, oldest removed first. Page buttons appear only on page results, because scanned files have none.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS, with the real-tools test skipped on a PC without them. Task 17 tests the real tools on Railway Free.

- [ ] **Step 5: Commit**

```bash
git add lib/page-extract.js lib/google.js server.js lib/channel-whatsapp.js Dockerfile tests/page-extract.test.js
git commit -m "feat(library): send just the matching page as a PDF or image"
```

## Part C: Chat web app

### Task 12: Web channel and saved conversations

**Files:**
- Create: `lib/conversations.js`, `lib/channel-web.js`
- Modify: `lib/db.js`
- Test: `tests/conversations.test.js`, `tests/web-channel.test.js`

**Interfaces:**
- Produces: `createConversations({ db, now }): { append(user, role, kind, body): number, since(user, afterSeq, limit = 200): Message[], savedWork(user, limit = 10): Message[], isEmpty(user): boolean }`, with `Message = { seq, role: "user"|"bot", kind: "text"|"choices"|"file"|"pages"|"rowcheck"|"note", body, ts }`
- Produces: `createWebChannel({ conversations, dataDir, now, uploads }): Adapter`; `supports.rowCheck` is true; `readGenerated(id, user): { path, name, mime }|null`. File refs are `drive:<id>` and `gen:<uuid>`.

- [ ] **Step 1: Write the failing tests**

```js
test("since returns only that user's rows, after the given seq");
test("longText stays one message");
test("buttons and list both become choices with id, title and description");
test("driveFile stores ref, name, folder and size");
test("pageHits stores a pages message with file ref, page and snippet");
test("generatedFile saves bytes under DATA_DIR and returns a gen ref");
test("another user cannot read a generated file", () => assert.equal(readGenerated(id, "other"), null));
test("generated files older than 30 days are removed at startup, and the folder stays under 200 MB, oldest first");
test("downloadMedia returns the uploaded bytes for that upload id");
test("each reply is logged to the CRM in the shape it already expects");
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/conversations.test.js tests/web-channel.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Follow the signatures above. `typing` does nothing on web. Call `crm.logOutbound` with the same payload shape `lib/wa.js` sends, so the usage log keeps working.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/conversations.js lib/channel-web.js lib/db.js tests/conversations.test.js tests/web-channel.test.js
git commit -m "feat(web): add the web channel and saved conversations"
```

### Task 13: Sign-in with personal links

**Files:**
- Create: `web/auth.js`, `scripts/make-invite.js`, `lib/control-sheet.js`
- Modify: `server.js`, `.env.example`
- Test: `tests/web-auth.test.js`, `tests/control-sheet.test.js`

**Interfaces:**
- Produces: `makeInviteToken(number, { secret, now, days = 14 })`, `verifyInviteToken(token, { secret, now }): { number }|null`, `makeSession(number, { secret, now })`, `readSession(cookieHeader, { secret, now }): { number }|null`, `requireUser({ secret, getAccounts }): ExpressMiddleware` (sets `req.account`), `joinRoutes({ secret, getAccounts }): Router`
- Produces: `loadSheet(): Promise<{ knowledge, allowed, accounts }>` in `lib/control-sheet.js`, moved from `server.js`

- [ ] **Step 1: Write the failing tests**

```js
test("opening an invite link never signs in", async () => {
  const r = await get(`/join/${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("set-cookie"), null);
});
test("pressing the button signs in with an HttpOnly, SameSite=Lax cookie", async () => { /* POST */ });
test("tampered and expired invites show the expired-link page and sign nobody in");
test("an invite for a number not on the Allowed tab signs nobody in");
test("a signed-in person removed from Allowed gets 401 on the next request");
test("an unreadable Sheet with no saved list gives 503, never access");
test("WEB_SECRET unset makes every /app request 503");
test("loadSheet keeps the last good copy when a refresh fails, and throws when it has none");
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/web-auth.test.js tests/control-sheet.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Tokens are `base64url(payload).hmac` using `WEB_SECRET`. The session cookie is `hv_session`, `Path=/app`, 180 days, `Secure` when `req.secure`; set `app.set("trust proxy", 1)`. Copy: `Sign in to HVAC Assistant as <name>` with a `Sign in` button, and `This link has expired. Ask for a new one.` `scripts/make-invite.js <number>` prints `PUBLIC_URL/app/join/<token>`. Add `WEB_SECRET` and `PUBLIC_URL` to `.env.example`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS, with the replay unchanged.

- [ ] **Step 5: Commit**

```bash
git add web/auth.js scripts/make-invite.js lib/control-sheet.js server.js .env.example tests/web-auth.test.js tests/control-sheet.test.js
git commit -m "feat(web): sign in with personal links"
```

### Task 14: Chat API, files and uploads

**Files:**
- Create: `web/routes.js`
- Modify: `server.js`, `menu.js`, `tests/menu.test.js`
- Test: `tests/web-routes.test.js`

**Interfaces:**
- Consumes: `requireUser`, `createConversations`, `createWebChannel`, `deliverMessage`, `streamDriveFile`
- Produces: `createWebRoutes({ deliverMessage, conversations, webChannel, getFile, secret }): Router`, with these under `/app`: `GET /api/messages?after=<seq>` gives `{ messages, busy }`; `POST /api/messages` takes `{ text }` or `{ tapId, tapTitle, data }` and returns 202; `POST /api/upload?name=<name>` takes the raw body; `GET /files/<ref>`; `POST /api/share-link` takes `{ ref }` and returns `{ url }`. Public: `GET /s/<token>`.
- Produces: tap `saved|open`

- [ ] **Step 1: Write the failing tests**

```js
test("an empty conversation gets the welcome once");
test("text and taps reach deliverMessage as the signed-in number, in the webhook's message shape");
test("busy is true while handling, false after");
test("a blank message or one over 4000 characters gets 400");
test("a 33 MB upload gets 413 with: That file is too large. The limit is 32 MB.");
test("a .zip or unconverted HEIC upload gets 415 with: Send a photo, PDF or Excel file.");
test("/app with no session shows: Ask for your personal link to sign in.");
test("/files refuses a Drive id not in the library");
test("a Drive file is streamed to the person, not loaded whole");
test("/files refuses another person's generated file");
test("responses carry a same-origin CSP and nosniff");
test("share links work without login and stop after 7 days");
test("the menu offers document, quick selection, schedule, guided and question rows, and says HVAC Assistant");
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/web-routes.test.js tests/menu.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append the person's message to the conversation first: the text, the tap title, or the file name for uploads. Then call `deliverMessage(value, message, webChannel)` with `value = { contacts: [{ profile: { name } }] }` and `message` shaped as the webhook sends it: `{ type: "text", text: { body } }`, `{ type: "interactive", interactive: { type: "button_reply", button_reply: { id, title } } }`, or `{ type: "image"|"document", ... }` carrying an upload id. Allowed upload types are JPEG, PNG, WebP, PDF, XLSX, XLS and CSV. Upload limit is 32 MB. Reorder `MENU_OPTIONS` to: Documents, Quick selection, Read a schedule, Guided selectors, Ask a question, Help. The Documents tip explains `find sound level`. Tapping Read a schedule starts the schedule flow. Replace "Mannai HVAC Assistant" with "HVAC Assistant". Share tokens use `WEB_SECRET`. `/files` and share links stream from Drive with `streamDriveFile`, and generated files stream from disk.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS. Update the replay baseline only for the menu wording, and review it with `diff.js`.

- [ ] **Step 5: Commit**

```bash
git add web/routes.js server.js menu.js tests/web-routes.test.js tests/menu.test.js
git commit -m "feat(web): add the chat API, file delivery and uploads"
```

### Task 15: The chat screen

**Files:**
- Create: `web/public/index.html`, `web/public/app.js`, `web/public/render.js`, `web/public/styles.css`, `web/public/manifest.webmanifest`, `web/public/icon-192.png`, `web/public/icon-512.png`, `.claude/launch.json` (not committed)
- Modify: `web/routes.js` (serves `web/public` at `/app` for signed-in people)
- Test: `tests/web-render.test.js`

**Interfaces:**
- Consumes: the Task 14 routes
- Produces: `renderRich(text): string` (safe HTML), `imageTargetSize(w, h, max = 2000): { w, h }`, `shareMode(size, canShareFiles): "file"|"link"`, in `render.js`, usable from Node and the browser

- [ ] **Step 1: Write the failing tests**

```js
test("HTML is escaped", () => assert.doesNotMatch(renderRich("<img src=x onerror=1>"), /<img/));
test("*bold* and _italic_ render; a lone star stays a star", () => {
  assert.match(renderRich("*Hi*"), /<strong>Hi<\/strong>/);
  assert.equal(renderRich("5 * 2"), "5 * 2");
});
test("https links are clickable, javascript: is not");
test("photos shrink to 2000 px on the long side and small ones stay", () => {
  assert.deepEqual(imageTargetSize(4000, 3000), { w: 2000, h: 1500 });
  assert.deepEqual(imageTargetSize(800, 600), { w: 800, h: 600 });
});
test("files over 25 MB or without file sharing use a link", () => {
  assert.equal(shareMode(26 * 1024 * 1024, true), "link");
  assert.equal(shareMode(1000, false), "link");
  assert.equal(shareMode(1000, true), "file");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/web-render.test.js`
Expected: FAIL.

- [ ] **Step 3: Build the screen to match the approved mockup**

- **Layout:** header with icon, `HVAC Assistant`, `Catalogues, datasheets and selections` and a saved-work button; scrolling messages; message box pinned at the bottom with attach and send. Use `100dvh`, safe-area padding and light and dark themes. The input font is 16px so iPhones don't zoom.
- **Message kinds:** bubbles for `text`; tappable chips for `choices`; cards with Open and `Share to WhatsApp` for `file`; cards with `Page N`, the snippet and the buttons `Page as PDF` and `Page as image` for `pages`. An image file shows its picture in the chat.
- **Polling:** every 1.5 seconds while `busy`, and on window focus. Show `Typing…` while busy. Show `You're offline. Trying again…` when a request fails.
- **Sharing:** prefetch the file when a card appears, so the tap counts as the user's action. Use `navigator.share({ files })` when `shareMode` says `file`; otherwise get a share link and open `https://wa.me/?text=<encoded link>`.
- **Attach:** `accept="image/*,application/pdf,.xlsx,.xls,.csv"`. Redraw images to JPEG at quality 0.85 with `imageTargetSize`. If a photo can't be decoded, show `This photo couldn't be read. Try a screenshot or a PDF.`
- **Errors:** an empty send shows `Type a message first`.

- [ ] **Step 4: Run the tests, then check it in the browser**

Run: `npm test`, then `preview_start` with `hvac-app` and `resize_window` preset `mobile`.
Expected: tests pass. Find a document, search inside a PDF, run a quick selection and ask a question at mobile width with no console errors. Take a screenshot.

- [ ] **Step 5: Commit**

```bash
git add web/public web/routes.js tests/web-render.test.js
git commit -m "feat(web): add the chat screen"
```

### Task 16: Check-the-schedule table and the MTZ shortcut

**Files:**
- Modify: `server.js`, `lib/channel.js`, `lib/channel-web.js`, `web/public/app.js`
- Test: `tests/schedule-check.test.js`, `tests/mtz-express.test.js`

**Interfaces:**
- Consumes: `supports("rowCheck")`, `schedule.toKw(value, unit)`
- Produces: `applyRowEdits(rows, skipped, edits): { rows, skipped, errors: string[] }`; facade `sendRowCheck(to, rows, skipped)`; flow step `awaitRowCheck`; tap `rows-ok` with `data: { rows }`; tap `print`; `parseMtzExpress(text): { reqTC, reqSC, db, wb, amb }|null`. Put the pure functions in `lib/schedule-check.js` and `lib/mtz-express.js`.

- [ ] **Step 1: Write the failing tests**

```js
test("an edited capacity recalculates requiredKw", () => {
  // srcValue 18, srcUnit "TR" gives requiredKw close to 63.3
});
test("a fixed skipped row joins the rows, classified");
test("a bad number names that row in errors and changes nothing");
test("quantity below 1 is an error");
test("untouched rows stay identical");
test("the print tap gives the same report as typing print");
test("split and schedule results stay available for 30 days");
test("parseMtzExpress reads the shortcut", () => assert.deepEqual(
  parseMtzExpress("MTZ Selection 8.5TR 80/67/115"), { reqTC: 102, reqSC: null, db: 80, wb: 67, amb: 115 }));
test("it reads a sensible load", () => assert.equal(parseMtzExpress("MTZ Selection 8.5TR/7TR 80/67/115").reqSC, 84));
test("bare command and out-of-range values give null", () => {
  assert.equal(parseMtzExpress("MTZ Selection"), null);
  assert.equal(parseMtzExpress("MTZ Selection 8.5TR 200/67/115"), null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/schedule-check.test.js tests/mtz-express.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

When `supports("rowCheck")`, after reading a schedule the flow sends a `rowcheck` message and waits at `awaitRowCheck`. It shows tag, type, load, unit and quantity as inputs, with skipped rows highlighted. `Looks right` posts `rows-ok`; the server runs `applyRowEdits`, replies with any errors, or continues the normal questions. After results, send a `PDF report` button with id `print`. The MTZ trigger matches `/^mtz\s+selection\b/i`, and conditions come from the last three numbers.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test` and `node tests/replay/diff.js`
Expected: tests pass with `files lost: 0`. Recapture the baseline.

- [ ] **Step 5: Commit**

```bash
git add server.js lib/channel.js lib/channel-web.js lib/schedule-check.js lib/mtz-express.js web/public/app.js tests/schedule-check.test.js tests/mtz-express.test.js
git commit -m "feat(web): let people correct a schedule, and fix the MTZ shortcut"
```

### Task 17: Go live

**Files:**
- Delete: `web/public/share-test.html`, `render.yaml`
- Modify: `server.js`
- Test: `tests/app-config.test.js`

**Interfaces:**
- Consumes: everything above

- [ ] **Step 1: Write the failing test**

```js
test("with WhatsApp off, no timer makes a network call while idle");
```

- [ ] **Step 2: Remove the share test and confirm the test passes**

Remove the `/share-test` routes. Keep `psychro-engine.js` and `extract-split-data.js`. List every untracked stray file in the repo root and ask the user before deleting any.

Run: `npm test`, `node --check server.js` and `node tests/replay/diff.js`
Expected: tests pass with `files lost: 0`.

- [ ] **Step 3: Commit**

```bash
git add server.js tests/app-config.test.js
git rm web/public/share-test.html render.yaml
git commit -m "chore: remove the phone sharing test page"
```

- [ ] **Step 4: Ask the user for the go-live steps**

1. Keep the service on Railway Free with Serverless on.
2. Add a Railway volume at `/data`, and set `DATA_DIR=/data`, `WEB_SECRET` (generated into `.env`, never in chat) and `PUBLIC_URL`.
3. Approve the merge and push.
4. Open their invite from `node scripts/make-invite.js <number>`, and send the other 2 people theirs.

- [ ] **Step 5: Upload the search index**

Run: `node scripts/build-index.js`
Expected: the upload succeeds and admin `stats` shows the 518 PDFs.

- [ ] **Step 6: Verify on the live app**

On a real phone: a document search, a search inside a PDF, page 20 of `Infinair Profile.pdf` (119 MB) as a PDF and as an image, a schedule with the check table, a share to WhatsApp, and a message after a redeploy.
Expected: all work, the image is under 4 GB, memory in Railway's metrics stays under 0.5 GB, and the service sleeps when idle. If a large file's page job goes over the limit, offer page buttons only up to the largest size that worked, with `Open the full file` above that.
