require("dotenv").config();
// Force IPv4-first DNS resolution. Node 17+ defaults to "verbatim" order, which
// prefers IPv6. On hosts with a broken/blackholed IPv6 route to Google (Render
// instances among them), every connection to googleapis.com resets mid-response
// — surfacing as "Invalid response body while trying to fetch
// https://www.googleapis.com/oauth2/v4/token: Premature close". Retries don't
// help because every attempt picks the same dead IPv6 route. Preferring IPv4
// sidesteps it. Must run before any outbound request is made.
require("dns").setDefaultResultOrder("ipv4first");

// ============================================================
//  HVAC Assistant: document retrieval and chiller / package selection
//  - Google Sheet = control panel (the Allowed numbers)
//  - Claude Haiku only helps find a file when a typed name matches nothing
// ============================================================

const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const FormData = require("form-data");
const { buildSelectionReply, buildSelectionInteractive, handleButtonTap, interpretCode, parseSeriesRequest, seriesMenu, parseDatasheetRequest, datasheetMenu, detectDocType } = require("./products.js");
const { detectSeriesEntry, filenameFor, folderToDocType, datasheetFolderForSeries, datasheetCondition, DATASHEET_FOLDERS } = require("./catalogue-map.js");
const { routeChillerText, handleChillerButton } = require("./chillers.js");
const { findBrandDocs } = require("./brand-docs.js");
const { findFilesByName } = require("./lib/find-files-by-name.js");
const { hasSearchableExtras, rankFiles, stripFindVerb, isSearchAllTrigger, SEARCH_ALL_HINT, isAiSearchTrigger, AI_SEARCH_HINT } = require("./lib/broad-search.js");
const { parseSelection } = require("./lib/multi-select.js");

// One reply must not trigger dozens of Drive downloads and media uploads.
const MAX_BATCH_FILES = 10;
const { isCreditError, markExhausted, isExhausted, aiPausedMessage } = require("./lib/ai-credits.js");
const { createAi } = require("./lib/ai.js");
const { getDb, dataDir } = require("./lib/db.js");
const { createConversations } = require("./lib/conversations.js");
const { createWebChannel } = require("./lib/channel-web.js");
const { createWebRoutes, webErrorHandler } = require("./web/routes.js");
const { findAccount, runWithAccount, currentAccount } = require("./lib/accounts.js");
const { loadSheet } = require("./lib/control-sheet.js");
const { mountWeb, cleanSecret, MIN_SECRET_LENGTH } = require("./web/auth.js");
const { requireAdmin } = require("./lib/http-auth.js");
const { whatsappEnabled, requiredEnv, startupWarnings } = require("./lib/app-config.js");
const { parseRelatedFilesResponse } = require("./lib/related-files.js");
const { isMenuTrigger, smallTalkReply, welcomeMenuList, tipFor, optionForTap, MENU_OPTIONS } = require("./menu.js");
const { parseListRequest, parseUnsupportedSeriesListRequest, buildUnitList } = require("./product-facts.js");
const crm = require("./crm.js");
const docReq = require("./lib/doc-requests.js");
const docReqDedupe = docReq.createDedupe();
const { getSheets, getDrive, withRetry, driveFileId } = require("./lib/google.js");
const {
  listFolderFiles, docTypeFromFilename, fileMatchesDocType,
  findFilesInFolder, findExactFileInDoc, findDatasheetFiles, findChillerDatasheetFiles, displayName, shortPath,
} = require("./lib/drive-index.js");
const wa = require("./lib/wa.js");
const { createSenderRouter } = require("./lib/sender-api.js");
const { createStatusStore } = require("./lib/sender-status.js");
const { polishDraft } = require("./lib/sender-polish.js");
const { createNumberHealth, metaEventLines, CHECK_EVERY_MS } = require("./lib/number-health.js");
// Every reply goes through the channel facade, so it reaches whichever channel
// is handling the message. `wa` stays for the WhatsApp-only parts: the Bot
// Sender router and the number-health check.
const {
  runWithChannel, currentChannel, showTyping,
  sendText, sendLongText, sendButtons, sendList, sendDriveFile,
} = require("./lib/channel.js");
const { whatsappAdapter } = require("./lib/channel-whatsapp.js");
const { NOT_FOUND_MSG } = wa;

const app = express();
app.set("trust proxy", 1); // Railway's proxy: lets req.secure see https for the Secure cookie
app.use(express.json());

// WhatsApp is off unless WHATSAPP_ENABLED=true. Off means: no webhook, no
// /api/sender, and no number-health timer or checks (those make network calls).
const WA_ON = whatsappEnabled();

// Meta has dropped the bot's number back to PENDING before ("This person is
// no longer available"). Every request — webhook, Bot Sender, or just opening
// the bot URL in a browser, which also wakes a sleeping Railway deploy —
// gives the hourly check a chance to run and re-register the number.
const numberHealth = WA_ON ? createNumberHealth({
  getStatus: wa.getNumberStatus,
  register: wa.registerNumber,
  pin: process.env.WHATSAPP_REGISTER_PIN,
}) : null;
if (numberHealth) {
  app.use((req, res, next) => {
    numberHealth.maybeCheck();
    next();
  });
}

const {
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  ANTHROPIC_API_KEY,
  PORT = 3000,
} = process.env;

// Fail fast on required env; warn on optional. A missing required var
// otherwise surfaces as a confusing mid-request auth error. Only when run as
// the server: the replay test imports this file and must not be exited.
const REQUIRED_ENV = requiredEnv();
const OPTIONAL_ENV = ["ANTHROPIC_API_KEY", "DRIVE_FOLDER_ID", "ADMIN_PASSWORD", "ADMIN_NUMBERS", "CRM_SHEET_ID", ...(WA_ON ? ["WHATSAPP_REGISTER_PIN"] : [])];
if (require.main === module) {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`❌ Missing required env vars: ${missing.join(", ")} — refusing to start.`);
    process.exit(1);
  }
  for (const k of OPTIONAL_ENV.filter((k) => !process.env[k])) {
    console.warn(`⚠️  Optional env var ${k} is not set — related features are disabled.`);
  }
  if (!cleanSecret(process.env.WEB_SECRET)) {
    console.warn(`⚠️  WEB_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters — the web app (/app) is switched off (503). Generate one with the command in .env.example.`);
  }
  for (const line of startupWarnings()) console.warn(line);
  console.log(`📁 Data folder: ${dataDir()}`);
}

// `anthropic` still serves the Bot Sender polish (lib/sender-polish.js) and is the
// client behind `ai`. Every text call below goes through `ai`: one model, one
// monthly spending cap. With no key the client is null, so ai.available() is
// false and the database is never opened; with a key it opens on first use.
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const ai = createAi({ client: ANTHROPIC_API_KEY ? anthropic : null, db: getDb });

// The Google Sheet (the Allowed tab) is read by lib/control-sheet.js.
// Static Drive-ID map for chiller datasheets (built by build-chiller-ids.js).
// Key: "code|series" e.g. "5230|APCY-E" -> { id, name }.
// Allows button taps to skip listFolderFiles() entirely.
let chillerDriveIds = {};
try { chillerDriveIds = require('./chiller-drive-ids.json'); } catch (_) {}

// Static Drive-ID map for catalogue-map.js series (built by build-product-ids.js).
// Key: "<series name>|<docType>" e.g. "APMR-A|Catalogue" -> { id, name }.
// Lets resolveSeriesFile() skip listFolderFiles() entirely on a cache hit.
let productDriveIds = {};
try { productDriveIds = require('./product-drive-ids.json'); } catch (_) {}

// Unified per-user session state (the open menu, a numbered list, the last
// request). One store with one TTL and expiry rule, saved to SQLite so it
// survives a restart.
const store = require("./lib/session-store.js");
const { enqueue } = require("./lib/user-queue.js");

// ── Message deduplication ────────────────────────────────────────────────────
// WhatsApp retries the webhook when the server is cold-starting and the 200 OK
// arrives late. Each retry carries the same message.id. We track seen IDs for
// 5 minutes so duplicates are silently dropped without sending extra replies.
const _seenMsgIds = new Map(); // messageId -> timestamp
const MSG_DEDUP_TTL = 5 * 60 * 1000; // 5 minutes
function isDuplicate(msgId) {
  const now = Date.now();
  // Purge expired entries (keep the map small)
  for (const [id, ts] of _seenMsgIds) {
    if (now - ts > MSG_DEDUP_TTL) _seenMsgIds.delete(id);
  }
  if (_seenMsgIds.has(msgId)) return true;
  _seenMsgIds.set(msgId, now);
  return false;
}


// ============================================================
//  MATCHING
// ============================================================
// Levenshtein distance between two strings (for fuzzy "did you mean")
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return d[m][n];
}

// AI fallback for a lookup miss: finds documents that are genuinely relevant
// to the request (not just loosely related) so a not-found reply can offer
// alternatives instead of a dead end. Returns [] (never null) when nothing
// clears the relevance bar, so callers can do `if (hits.length)` directly.
async function aiRelatedFiles(text, files) {
  if (!ai.available() || !files.length) return [];

  const list = files.map((f, i) => `${i + 1}. ${f.name.replace(/\.[^.]+$/, "")}`).join("\n");

  const system = `A customer's request did not match any file exactly. Find documents from the list below that are GENUINELY RELEVANT to what they asked for — close enough that a human would reasonably offer them as alternatives.
The list may include SKM brand files as well as third-party brand catalogues (Hisense, Daikin, Mitsubishi, Trane, Carrier, etc.).
Use your knowledge of HVAC abbreviations and brand names:
- MAH = Modular Air Handling Unit (AHU)
- CAH = Comfort Air Handling Unit (AHU)
- FCU = Fan Coil Unit
- APMR-A = Packaged Air Conditioner
- AUMR-A = Air-Cooled Condensing Unit
- APCY-P / APCY-H / APCY-E = Air-Cooled Screw Chillers
- ACMR = Air-Cooled Scroll Chiller
- PAC4A = 100% Fresh Air Packaged Unit (DOAS)
- PAC4A 5xxxx = a specific PAC4A unit selection sheet
- VRF / VRV = Variable Refrigerant Flow/Volume multi-split system
- Also match third-party brand names directly (e.g. "Hisense VRF" matches any file with "Hisense" and "VRF" in the name)

Apply a STRICT relevance bar — do NOT suggest a file just because it shares a generic word (e.g. "unit", "catalogue") or a loosely related category. Only suggest files for the SAME product type/series/brand the customer asked about.

Reply with up to 5 numbers, best match first, separated by commas.
If NOTHING is genuinely relevant, reply with "0".
No other text.

FILES:
${list}`;

  const out = await ai.askText({ purpose: "aiRelatedFiles", system, user: text });
  return out ? parseRelatedFilesResponse(out, files) : [];
}

// Dispatch a chiller response descriptor from chillers.js (text / buttons /
// datasheet fetch). Keeps logging to the matched model/intent only.
async function sendChillerResponse(from, r) {
  if (!r) return;
  if (r.type === "text") return await sendText(from, r.text);
  if (r.type === "buttons") return await sendButtons(from, r.text, r.buttons);
  if (r.type === "datasheet") {
    const cachedFile = chillerDriveIds[`${r.code}|${r.series}`];
    if (cachedFile) {
      console.log(`❄️ Chiller datasheet (direct): ${r.series} ${r.code} -> ${cachedFile.name}`);
      return await sendDriveFile(from, cachedFile);
    }
    // Fallback: scan Drive (used when chiller-drive-ids.json hasn't been built yet)
    await sendText(from, "🔍 Looking up that datasheet…");
    const files = await listFolderFiles();
    const matches = findChillerDatasheetFiles(r.series, r.code, files);
    if (matches.length >= 1) {
      console.log(`❄️ Chiller datasheet: ${r.series} ${r.code} -> ${matches[0].name}`);
      return await sendDriveFile(from, matches[0]);
    }
    console.log(`❄️ Chiller datasheet not on file: ${r.series} ${r.code}`);
    return await sendText(
      from,
      `Apologies — the ${r.series} ${r.code} datasheet isn't available yet; kindly email hassan.saleem@mannai.com.qa to get the required document.`
    );
  }
}


//      free, no guessing. This is the primary path now that we have the full
//      Drive file list mapped.
//   2) Old prefix matcher, then AI — only as a safety net for a series that
//      isn't in the map yet, or a file that was renamed in Drive.
async function resolveSeriesFile(seriesNameOrText, docType, getFiles) {
  // 1) Deterministic map by exact filename.
  const entry = detectSeriesEntry(seriesNameOrText);
  if (entry) {
    const exact = filenameFor(entry, docType); // exact filename or null
    if (exact) {
      // 1a) Pre-resolved Drive-ID cache — skip the live scan entirely.
      const cached = productDriveIds[`${entry.name}|${docType}`];
      if (cached) {
        console.log(`📖 Map (direct): ${entry.name} ${docType} -> ${cached.name}`);
        return cached;
      }
      // 1b) Cache miss — fall back to the live scan + exact match.
      const files = await getFiles();
      const hit = findExactFileInDoc(exact, docType, files);
      if (hit) {
        console.log(`📖 Map: ${entry.name} ${docType} -> ${hit.name}`);
        return hit;
      }
      console.log(`⚠️  Map expected "${exact}" in ${docType} but it wasn't indexed (cache/rename?). Falling back.`);
      return await fallbackResolve(seriesNameOrText, docType, files);
    }
    // The map KNOWS this series has no file of this type. Be honest.
    console.log(`ℹ️  ${entry.name} has no ${docType} on file.`);
    return null;
  }

  // 2) No map entry at all — safety net: old prefix matcher.
  const files = await getFiles();
  return await fallbackResolve(seriesNameOrText, docType, files);
}

// Safety net for series with no map entry, or where the map's expected
// filename wasn't found live (renamed/removed in Drive since last cache build).
async function fallbackResolve(seriesNameOrText, docType, files) {
  const hits = findFilesInFolder(seriesNameOrText, files, docType);
  if (hits.length >= 1) return hits[0];

  // Nothing found: return null. No AI here — the caller drops to
  // sendNotFoundByName, which runs the free ranked scan first and only
  // then AI search, so no call is spent before the free scan has been tried.
  return null;
}

// ============================================================
//  SENDING
// ============================================================
// sendText/sendLongText/sendButtons/sendList/sendDriveFile
// come from lib/channel.js (imported above); the WhatsApp side is lib/wa.js.

// Send a unit list in the chosen unit system, then a small
// button message offering to switch Imperial <-> International. The list itself
// can exceed the 1024-char interactive-body limit, so it goes as plain text
// (sendLongText) and the toggle rides in a separate button message.
//   system: "si"  = International (kW, m³/h) · "imp" = Imperial (TR, CFM)
async function sendListWithToggle(from, keys, system) {
  const body = buildUnitList(keys, system);
  if (!body) return false;
  await sendLongText(from, body);
  store.setCtx(from, "unitList", { keys, system }, 30 * 60 * 1000);
  const other = system === "si" ? "imp" : "si";
  const curName = system === "si" ? "International (kW)" : "Imperial (TR)";
  const otherTitle = other === "si" ? "International (kW)" : "Imperial (TR)";
  await sendButtons(
    from,
    `📐 Showing in *${curName}*. Tap to switch units:`,
    [{ id: `units|${other}`, title: otherTitle }]
  );
  return true;
}

// ============================================================
//  WEBHOOK VERIFY
// ============================================================
if (WA_ON) app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(req.query["hub.challenge"]);
  }
  return res.sendStatus(403);
});

// Send multiple file matches smartly:
//   1 match   → send it directly
//   2-3       → WhatsApp reply buttons (tappable)
//   4-10      → WhatsApp interactive list (tappable rows)
//   11+       → numbered text list (user replies "1", "2", …) — API row cap
// Shown under every document picker. Tapping a row gives one file; several
// are picked by replying with numbers, since WhatsApp lists are single-select.
const MULTI_PICK_HINT =
  "Tap one to get it — or reply with several numbers (*1,3,5* or *1-4*), or *all* for everything.";

// Send several documents in one go. Sequential on purpose: each file is a
// Drive download plus a WhatsApp media upload, and firing ten at once invites
// rate-limiting and out-of-order delivery. One failure must not kill the
// batch, so each send is isolated and the misses are reported at the end.
async function sendManyFiles(to, files) {
  if (!files.length) return;
  if (files.length === 1) return sendDriveFile(to, files[0]);

  await sendText(to, `📦 Sending ${files.length} documents…`);
  const failed = [];
  for (const file of files) {
    try {
      await sendDriveFile(to, file);
    } catch (err) {
      console.error(`❌ batch send failed for ${file.name}:`, err.message);
      failed.push(file);
    }
  }
  console.log(`📦 batch: ${files.length - failed.length}/${files.length} sent to ${to}`);
  if (failed.length) {
    return sendText(to,
      `⚠️ I couldn't send ${failed.length} of them:\n` +
      failed.map((f) => `• ${displayName(f)}`).join("\n") +
      "\n\nAsk for those by name and I'll try again.");
  }
}

// Both escape hatches, in cost order. The AI one is only advertised while AI is
// available — offering a command that answers "paused" is worse than not offering it.
function escapeHatchHint() {
  return ai.available() ? `${SEARCH_ALL_HINT}\n${AI_SEARCH_HINT}` : SEARCH_ALL_HINT;
}

// `requestQuery`: when these are guesses for a search, a "📥 Not here?
// Request it" row is added (if a row is free) so the user can ask for the
// real document to be added to the library.
async function sendFileOptions(to, matchedFiles, prompt, autoSendSingle = true, requestQuery = null) {
  if (autoSendSingle && matchedFiles.length === 1) return sendDriveFile(to, matchedFiles[0]);

  // autoSendSingle === false means these are GUESSES, not a confident match.
  // Whenever we're guessing, offer BOTH escape hatches so the user can jump
  // straight to AI instead of being made to try the free scan first.
  if (!autoSendSingle) prompt = `${prompt || "I found several matches:"}\n\n${escapeHatchHint()}`;

  // 1-10 matches: tappable list rows (title = short name, description = the
  // folder the file sits in, so two similarly-named documents are tellable
  // apart by where they live). buildListPayload enforces WhatsApp's hard
  // limits — 10 rows, title 24 chars, description 72 — for every caller.
  // displayName() has already stripped the extension, so a truncated title
  // never wastes characters on ".pdf".
  if (matchedFiles.length <= 10) {
    store.clearCtx(to, "menu");
    // Remember the candidates so a text reply can pick several ("1,3" / "all").
    // A list row tap only ever returns ONE id — WhatsApp has no multi-select.
    store.setCtx(to, "list", matchedFiles, 30 * 60 * 1000);

    const rows = matchedFiles.map((f) => ({
      id: `fileid|${f.id}`,
      title: displayName(f),
      description: shortPath(f.folder),
    }));
    // "Send all" needs something to send all OF, and needs a spare row — a
    // section holds 10. At a full 10 the body hint still offers "all" as a
    // text reply.
    const multi = matchedFiles.length >= 2;
    if (multi && rows.length < 10) {
      rows.push({
        id: "sendall",
        title: `📦 Send all ${matchedFiles.length}`,
        description: "Get every document above in one go",
      });
    }
    if (requestQuery && rows.length < 10) {
      rememberRequest(to, requestQuery);
      rows.push(docReq.REQUEST_ROW);
    }
    const body = multi
      ? `${prompt || "I found several matches:"}\n\n${MULTI_PICK_HINT}`
      : (prompt || "Is this the one?");
    return sendList(to, body, "Choose a document", rows);
  }

  // 11+ matches: numbered text list stored for the next reply.
  store.clearCtx(to, "menu");
  store.setCtx(to, "list", matchedFiles, 30 * 60 * 1000);
  const list = matchedFiles.map((f, i) => `${i + 1}. ${displayName(f)}`).join("\n");
  return sendText(to, `${prompt || "I found several matches:"}\n\n${list}\n\n${MULTI_PICK_HINT}`);
}

// Last-resort reply for a lookup miss: ask AI for documents that are
// genuinely relevant to the request and offer them as a caveated choice
// (never auto-sent — a related match is a guess, not a confirmed answer).
// Falls back to the plain NOT_FOUND_MSG when nothing clears the relevance
// bar. `files` is optional — pass the already-fetched Drive index when the
// caller has one in scope; otherwise it's fetched here (cheap:
// listFolderFiles() answers from the saved library list).
// Dead end: send `body` with the "📥 Request it" button (after any `extra`
// buttons — WhatsApp allows 3). The query is remembered so the tap knows
// what to request.
function rememberRequest(to, query) {
  store.setCtx(to, docReq.CTX_KEY, query, docReq.DEDUPE_MS);
}
function sendWithRequestButton(to, query, body, extra = []) {
  rememberRequest(to, query);
  return sendButtons(to, `${body}\n\n${docReq.REQUEST_PROMPT}`, [...extra, docReq.REQUEST_BUTTON]);
}

// The "📥 Request it" tap: log to the CRM Requests tab, alert the admin(s),
// confirm to the user. The admin alert is best-effort — Meta only delivers a
// free-form message inside the admin's 24h window — the sheet row is the record.
async function handleDocRequest(from, name) {
  const query = store.getCtx(from, docReq.CTX_KEY);
  if (!query) {
    return sendText(from, "That request has expired — search for the document again and tap *Request it*.");
  }
  if (docReqDedupe.seen(from, query)) {
    console.log(`📥 duplicate library request from ${from}: "${query}"`);
    return sendText(from, docReq.duplicateText(query));
  }
  const logged = await crm.logDocRequest({ from, name, query });
  let alerted = 0;
  for (const admin of docReq.alertNumbers()) {
    // send() never throws — false means Graph rejected it. Accepted can still
    // fail later with 131047 (admin outside the 24h window), via webhook status.
    if (await sendText(admin, docReq.adminAlertText({ from, name, query }))) alerted++;
    else console.error(`📥 admin alert to ${admin} was rejected`);
  }
  console.log(`📥 library request "${query}" from ${from}: sheet=${logged} alerts=${alerted}`);
  if (!logged && !alerted) {
    return sendText(from,
      `Sorry, I couldn't send the request just now. Please email hassan.saleem@mannai.com.qa ` +
      `and ask for *"${query}"*.`);
  }
  return sendText(from, docReq.confirmText(query));
}

async function sendNotFoundByName(to, text, files) {
  const fileList = files || (await listFolderFiles());

  // ── FREE FIRST ────────────────────────────────────────────────
  // Ranked keyword scan of the WHOLE index — filenames and folder paths,
  // pure JS, no API call. This runs before anything that costs money, for
  // whatever the credit balance.
  const ranked = rankFiles(text, fileList, 10);
  if (ranked.length) {
    console.log(`🗂️  Free scan matched "${text}": ${ranked.length} hit(s)`);
    return sendFileOptions(to, ranked, `Closest matches for "${text}":`, false, text);
  }

  // ── Nothing free matched: AI looks harder, by itself ─────────────
  // The free scan above already failed. AI is one capped, cheap call; when it is
  // unavailable (no key, credit latch, monthly cap) say so and offer the request.
  if (!ai.available()) {
    console.log(`⏸️  AI unavailable -> paused message for "${text}"`);
    return sendWithRequestButton(to, text, aiPausedMessage());
  }
  console.log(`🤖 Free scan missed "${text}" -> AI search`);
  return runAiSearch(to, text, (t) => sendText(to, t));
}

// The AI search pass, run after the free scan misses and by the "ai search"
// command. Reads the whole index, not a doc-type-filtered slice.
async function runAiSearch(to, query, announce) {
  if (!ai.available()) return sendWithRequestButton(to, query, aiPausedMessage());

  if (announce) await announce(`🤖 Searching every file with AI for "${query}"…`);
  const files = await listFolderFiles();
  const hits = await aiRelatedFiles(query, files);
  console.log(`🤖 AI search "${query}" -> ${hits.length} hit(s)`);
  if (hits.length) {
    return sendFileOptions(to, hits,
      `AI's closest matches for "${query}":`, false, query);
  }

  return sendWithRequestButton(to, query,
    `Even AI couldn't find anything matching "${query}" in the Drive folder.\n\n` +
    "I find documents (catalogues, IOM manuals and datasheets); I can't answer questions about specs in words. " +
    "It may not be uploaded yet.");
}


// ── Welcome menu, saved work ────────────────────────────────────────────
// The menu as a list (a numbered reply still works for 15 minutes).
async function showWelcomeMenu(from, profileName) {
  const m = welcomeMenuList(profileName, crm.isKnownContact(from));
  store.setCtx(from, "menu", { open: true }, 15 * 60 * 1000); // numbers are read against the menu as it is now
  return await sendList(from, m.body, m.buttonLabel, m.rows);
}

// What an old tap gets when the option it belonged to has gone.
const MSG_OPTION_GONE = "That option is no longer available. Send me what you're looking for, or type *menu* to see what I can do.";

// The web chat's own parts: conversations and the channel that writes to them.
// Made on first use, so requiring this file opens no database. Both share the
// app's one database.
let webMade = null;
function webParts() {
  if (!webMade) {
    const conversations = createConversations({ db: getDb() });
    webMade = { conversations, channel: createWebChannel({ conversations }) };
  }
  return webMade;
}
const lazyWebPart = (name) => new Proxy({}, {
  get(_, key) {
    const part = webParts()[name];
    const v = part[key];
    return typeof v === "function" ? v.bind(part) : v;
  },
});
const webConversations = lazyWebPart("conversations");
const webChannel = lazyWebPart("channel");

// "Saved work": the person's last 10 files (Drive and made-for-you) shown again
// at the bottom of the chat, newest last, as the file messages they were.
async function sendSavedWork(to) {
  const saved = webParts().conversations.savedWork(to, 10);
  if (!saved.length) return await sendText(to, "Nothing saved yet. Files I send you are kept here.");
  await sendText(to, `Your last ${saved.length} file${saved.length === 1 ? "" : "s"}, newest at the bottom:`);
  for (const m of saved.reverse()) webParts().conversations.append(to, "bot", "file", m.body);
}

// ============================================================
//  WEBHOOK RECEIVER
// ============================================================
async function handleIncomingMessage(value, message) {
    const from = message.from;

    // Blue-tick + "typing…" right away; clears when our reply sends.
    showTyping(message.id); // fire-and-forget by design

    // CRM: log who asked what, when. The profile name rides along in the
    // webhook payload; the reply is attached later via the send() hook.
    // The name you set in the Sheet's Allowed tab wins over the WhatsApp
    // profile name — it's the one you control and keep accurate.
    const profileName = currentAccount()?.name || value?.contacts?.[0]?.profile?.name || "";
    const inboundText =
      message.type === "text" ? message.text.body.trim()
      : message.type === "interactive" && message.interactive?.type === "button_reply"
        ? `btn:${message.interactive.button_reply.title || message.interactive.button_reply.id}`
      : message.type === "interactive" && message.interactive?.type === "list_reply"
        ? `btn:${message.interactive.list_reply.title || message.interactive.list_reply.id}`
      : `[${message.type}]`;
    crm.logInbound({ from, name: profileName, text: inboundText });

    // --- Button tap or list-row tap? (interactive reply) ---
    // A list-row tap carries the same kind of id as a button tap — normalize
    // and let the single button-id dispatcher below handle both.
    const tapId =
      message.type === "interactive" && message.interactive?.type === "button_reply" ? message.interactive.button_reply.id
      : message.type === "interactive" && message.interactive?.type === "list_reply" ? message.interactive.list_reply.id
      : null;
    if (tapId) {
      const btnId = tapId;
      console.log(`🔘 ${from} tapped: ${btnId}`);

      // Menu row tap -> that section's tip card. A row this menu no longer has
      // (an old message's) gets the same reply as any other tap that is gone.
      if (btnId.startsWith("menu|")) {
        const opt = optionForTap(btnId);
        return await sendText(from, opt ? opt.tip : MSG_OPTION_GONE);
      }

      // "Saved work" on the web chat: the person's recent files again, at the bottom.
      // WhatsApp never offers this tap, so there it is an unknown tap like any other.
      if (btnId === "saved|open" && currentChannel()?.name === "web") return await sendSavedWork(from);

      // Chiller buttons (chmodel|, chsel|, chds|) -> series pick / spec / datasheet.
      const chillerBtn = handleChillerButton(btnId);
      if (chillerBtn) return await sendChillerResponse(from, chillerBtn);

      // Unit toggle (units|si / units|imp) -> re-render the last list in the
      // chosen system. State remembers which list it was.
      if (btnId.startsWith("units|")) {
        const system = btnId.split("|")[1] === "imp" ? "imp" : "si";
        const st = store.getCtx(from, "unitList");
        // a list that expired, or one saved by an older version that this one cannot draw
        if (!st || !(await sendListWithToggle(from, st.keys, system))) {
          return await sendText(from, "That list has expired — just ask for it again (e.g. *APMR list*).");
        }
        return;
      }

      const action = handleButtonTap(btnId);
      if (action?.type === "interactive") {
        return await sendButtons(from, action.text, action.buttons);
      }
      // Catalogue / IOM choice -> fetch from that folder ONLY
      if (action?.type === "folderFile") {
        const file = await resolveSeriesFile(action.series, action.docType, listFolderFiles);
        if (file) return await sendDriveFile(from, file);
        return await sendNotFoundByName(from, `${action.series} ${action.docType}`);
      }
      // Datasheet condition chosen (T1/T3) -> fetch that exact file by ID.
      if (action?.type === "datasheetFile") {
        const files = await listFolderFiles();
        const file = files.find((f) => f.id === action.fileId);
        if (file) return await sendDriveFile(from, file);
        return await sendText(
          from,
          NOT_FOUND_MSG
        );
      }
      if (action?.type === "sheet") {
        // fetch the model data sheet PDF from the Drive folder by name
        const files = await listFolderFiles();
        let hits = findFilesByName(action.fileName, files);
        // If condition (t1/t3) is known, filter to the matching file
        if (action.condition && hits.length > 1) {
          const condUpper = action.condition.toUpperCase(); // "T1" or "T3"
          const condFiltered = hits.filter((f) => {
            const n = f.name.toUpperCase();
            return n.includes(`-${condUpper}`) || n.includes(`_${condUpper}`) || n.includes(` ${condUpper}`);
          });
          if (condFiltered.length >= 1) hits = condFiltered;
        }
        if (hits.length >= 1) return await sendDriveFile(from, hits[0]);
        return await sendNotFoundByName(from, action.fileName, files);
      }
      // Doc-type choice button: "doctype|IOM|<query>" or "doctype|Catalogue|<query>"
      if (btnId.startsWith("doctype|")) {
        const [, docType, ...queryParts] = btnId.split("|");
        const query = queryParts.join("|");
        const files = await listFolderFiles();
        const filtered = files.filter((f) => fileMatchesDocType(f, docType));
        // Free first: exact/substring, then the ranked keyword scan. Only if
        // both miss do we hand off to the consent prompt.
        const named = findFilesByName(query, filtered);
        if (named.length) return await sendFileOptions(from, named, `${docType} — which product?`);
        const ranked = rankFiles(query, filtered, 10);
        if (ranked.length) return await sendFileOptions(from, ranked, `${docType} — closest matches:`, false, query);
        return await sendNotFoundByName(from, query, files);
      }
      // FCU model sheet: "fcu-sheet|DMP-10" -> find 3-row & 4-row datasheets for that model.
      if (btnId.startsWith("fcu-sheet|")) {
        const model = btnId.slice(10); // e.g. "DMP-10"
        const files = await listFolderFiles();
        // Normalize model name (DMP-10 -> dmp10) and find files whose name contains it.
        const norm = (s) => s.toLowerCase().replace(/[\s\-_.]/g, "");
        const q = norm(model);
        const hits = files.filter((f) => {
          const base = norm(f.name.replace(/\.[^.]+$/, ""));
          // Must start with model prefix AND be in a DMP/DCMP selection folder
          return base.startsWith(q) && /fcu.*(dmp|dcmp)/i.test(f.folder || "");
        });
        if (hits.length >= 1) return await sendFileOptions(from, hits, `${model} datasheets (choose coil rows):`);
        // Fallback: search by name anywhere in Drive if folder filter missed
        const fallback = files.filter((f) => norm(f.name.replace(/\.[^.]+$/, "")).startsWith(q) && f.name.toLowerCase().endsWith(".pdf"));
        if (fallback.length >= 1) return await sendFileOptions(from, fallback, `${model} datasheets:`);
        return await sendNotFoundByName(from, model, files);
      }

      // "📥 Request it" — ask for a missing document to be added to the library.
      if (btnId === docReq.REQUEST_BUTTON.id) {
        return await handleDocRequest(from, profileName);
      }

      // "📦 Send all" row from a document picker.
      if (btnId === "sendall") {
        const pending = store.getCtx(from, "list");
        if (!pending || !pending.length) {
          return await sendText(from, "That list has expired — search again and I'll offer it fresh.");
        }
        store.clearCtx(from, "list");
        console.log(`📦 ${from} tapped send-all: ${pending.length} file(s)`);
        return await sendManyFiles(from, pending.slice(0, MAX_BATCH_FILES));
      }

      // Direct file by Drive ID (used by sendFileOptions buttons)
      if (btnId.startsWith("fileid|")) {
        const fileId = btnId.slice(7);
        const files = await listFolderFiles();
        const file = files.find((f) => f.id === fileId);
        if (file) return await sendDriveFile(from, file);
        return await sendText(from, NOT_FOUND_MSG);
      }

      // A tap on something this version no longer offers (an old message's button).
      return await sendText(from, MSG_OPTION_GONE);
    }

    // ── Global escape: a bare greeting / "menu" / "help" ALWAYS shows the menu
    // and clears what it was waiting for (an open menu, a numbered list). Runs
    // BEFORE every other check.
    // isMenuTrigger only matches whole-message greetings/menu words, so it never
    // hijacks a real request like "hi can I get the APMR catalogue".
    if (message.type === "text" && isMenuTrigger(message.text.body)) {
      store.clearAll(from);
      console.log(`📋 welcome menu (global escape) -> ${from}`);
      return await showWelcomeMenu(from, profileName);
    }

    // Nothing reads a photo or a file any more, so one that arrives is left alone.
    if (message.type !== "text") return;
    let text = message.text.body.trim(); // a "find ..." that is really a document request continues without the verb

    // Reply to a pending document list: "2", "1,3,5", "1-4", or "all".
    // parseSelection returns null for anything that isn't a pick, so real
    // queries fall straight through to normal routing.
    const pendingList = store.getCtx(from, "list");
    if (pendingList) {
      const picked = parseSelection(text, pendingList.length, { cap: MAX_BATCH_FILES });
      if (picked) {
        const chosen = picked.indices.map((i) => pendingList[i]);

        if (!chosen.length) {
          return await sendText(from,
            `There ${pendingList.length === 1 ? "is" : "are"} only ${pendingList.length} ` +
            `document${pendingList.length === 1 ? "" : "s"} on that list — reply with a number ` +
            `between 1 and ${pendingList.length}, or *all*.`);
        }

        store.clearCtx(from, "list");
        console.log(`🔢 ${from} selected ${chosen.length}: ${chosen.map((f) => f.name).join(", ")}`);

        // Tell them about anything skipped BEFORE the files start arriving,
        // otherwise the note is buried under a stack of documents.
        const notes = [];
        if (picked.invalid.length) {
          // "1-40" on a 6-item list would otherwise enumerate 34 numbers.
          notes.push(picked.invalid.length > 3
            ? `The list only goes up to ${pendingList.length}, so I ignored the higher numbers.`
            : `Ignoring ${picked.invalid.join(", ")} — the list only goes up to ${pendingList.length}.`);
        }
        if (picked.capped) {
          notes.push(`Sending the first ${MAX_BATCH_FILES}; ask again for the rest.`);
        }
        if (notes.length) await sendText(from, `⚠️ ${notes.join(" ")}`);

        return await sendManyFiles(from, chosen);
      }
    }

    console.log(`📩 ${from}: "${text}"`);

    // ── Welcome menu / help ──────────────────────────────────────
    // Numbered reply while a recent menu is open -> send that section's
    // "how to ask" tip card.
    const openMenu = store.getCtx(from, "menu");
    if (/^\d+$/.test(text) && openMenu) {
      const n = parseInt(text, 10);
      const tip = tipFor(n);
      if (tip) {
        console.log(`📋 ${from} menu pick ${n}`);
        return await sendText(from, tip);
      }
      return await sendText(from, `Please reply with a number between 1 and ${MENU_OPTIONS.length}, or type *menu*.`);
    }

    // A bare number with no open menu/list would fall into document search and
    // return nonsense. Nudge instead.
    if (/^\d{1,2}$/.test(text)) {
      return await sendText(from, "That menu or list has expired. Type *menu* to see your options, or just tell me what you need — e.g. *APMR catalogue*.");
    }

    // Admin: "stats" -> usage summary from the CRM log. Restricted to
    // ADMIN_NUMBERS (comma-separated env var), else the default admin.
    // Falls through to normal routing for non-admins.
    if (/^stats$/i.test(text)) {
      if (docReq.isAdmin(from)) {
        console.log(`📊 stats -> ${from}`);
        return await sendText(from, await crm.statsMessage());
      }
    }

    // Greeting / "menu" / "help" -> show the welcome menu (numbered list).
    if (isMenuTrigger(text)) {
      console.log(`📋 welcome menu -> ${from}`);
      store.clearCtx(from, "list");
      return await showWelcomeMenu(from, profileName);
    }
    // Conversational closing / thanks / ack ("bye", "exit", "thanks", "ok") ->
    // reply politely and stop. Must run BEFORE the "searching" notice and the
    // AI fallback so these never trigger a document search.
    const smalltalk = smallTalkReply(text);
    if (smalltalk) {
      console.log(`💬 small talk -> ${from}`);
      store.clearCtx(from, "menu");
      store.clearCtx(from, "list");
      return await sendText(from, smalltalk);
    }
    // ─────────────────────────────────────────────────────────────

    // One-time "searching" acknowledgement for document requests, so the user
    // gets instant feedback while the bot hits Drive / runs a match. Fires at
    // most once per message regardless of which lookup path handles it.
    let announcedSearch = false;
    const announceSearch = async (label) => {
      if (announcedSearch) return;
      announcedSearch = true;
      try { await sendText(from, label || "🔍 Searching our library, one moment…"); } catch (_) {}
    };

    // ── "search all" escape hatch ────────────────────────────────
    // Offered whenever a guess might be wrong. Re-runs the user's LAST query
    // as a ranked scan of the entire Drive index (filename + folder path),
    // deterministic and free — no Claude call.
    // "search all manuals" / "search all trane" carry their own words: the same
    // scan, over those words instead of the last request.
    const wideSearchAll = isSearchAllTrigger(text) ? null : /^\s*search\s+(?:all|everything|drive)\s+(.+?)\s*$/i.exec(text);
    if (isSearchAllTrigger(text) || wideSearchAll) {
      const lastQuery = wideSearchAll ? wideSearchAll[1] : store.getCtx(from, "lastquery");
      if (wideSearchAll) store.setCtx(from, "lastquery", lastQuery, 30 * 60 * 1000);
      if (!lastQuery) {
        return await sendText(from,
          "Tell me what to look for first — send the document name or a few words about it, " +
          "then reply *search all* if my suggestions miss.");
      }
      await announceSearch(`🔍 Searching every file for "${lastQuery}"…`);
      const hits = rankFiles(lastQuery, await listFolderFiles(), 10);
      console.log(`🗂️  search-all "${lastQuery}" -> ${hits.length} hit(s)`);
      if (!hits.length) {
        // Free scan exhausted. NOW offer AI — never before, so a Claude call
        // only happens once the free path has genuinely failed.
        return await sendText(from,
          `I searched every file name and folder in the Drive folder and found nothing close to "${lastQuery}".\n\n` +
          (ai.available()
            ? AI_SEARCH_HINT
            : "Try a word from the document's title, or email hassan.saleem@mannai.com.qa."));
      }
      return await sendFileOptions(from, hits,
        `Closest matches for "${lastQuery}" across all folders:`, false);
    }

    // ── "ai search": last resort, costs a Claude call ────────────
    // Only reachable after the free scan missed. Reads the whole index, not a
    // doc-type-filtered slice, so it can reach Submittal Files and the like.
    // Typing "ai search" asks for it explicitly, even when the automatic pass already ran.
    if (isAiSearchTrigger(text)) {
      const lastQuery = store.getCtx(from, "lastquery");
      if (!lastQuery) {
        return await sendText(from, "Tell me what to look for first, then reply *ai search*.");
      }
      return await runAiSearch(from, lastQuery, announceSearch);
    }

    // "find ..." / "search ...": the same as typing what follows the verb. The
    // words go through every router below exactly as if the verb were not there
    // ("search all" and "ai search" were caught above and keep their meaning).
    const findQuery = stripFindVerb(text);
    if (findQuery) text = findQuery;

    // Remember what they actually asked for, so a later "search all" knows
    // what to re-run. Set once here rather than in each lookup path, so every
    // route that can produce a wrong guess gets the escape hatch for free.
    store.setCtx(from, "lastquery", text, 30 * 60 * 1000);

    // ── List units in a series ───────────────────────────────────
    // "give me list of APMR units", "list all DMP models", "what chillers do
    // you have" -> every model in that series with capacity + airflow.
    const listReq = parseListRequest(text);
    if (listReq) {
      console.log(`📋 unit list: ${listReq.join(", ")}`);
      return await sendListWithToggle(from, listReq, "imp");
    }

    // ── List request for a series with no spec table on file ─────
    // "ACMR models", "list of CRAC" -> say a model list isn't available
    // yet and offer the catalogue (which lists every model) as a download.
    const unsupportedListReq = parseUnsupportedSeriesListRequest(text);
    if (unsupportedListReq) {
      console.log(`📋 unit list unavailable: ${unsupportedListReq.name}`);
      if (unsupportedListReq.catalogue) {
        return await sendButtons(
          from,
          `A model list isn't available for ${unsupportedListReq.name} yet. You can download the catalogue, which lists every model:`,
          [{ id: `doc|${unsupportedListReq.name}|Catalogue`, title: "Download Catalogue" }]
        );
      }
      return await sendText(
        from,
        `A model list isn't available for ${unsupportedListReq.name} yet, and no catalogue is on file for it either. Please contact us for details.`
      );
    }

    // 1-chiller) APCY-E / APCY-H chiller intents: model lookup, tonnage select,
    //   datasheet, and series/model comparison. Runs in the equipment-SELECTION
    //   band (before the free-form lookup) so "chiller"/"ton"/"TR" never get
    //   intercepted by a generic keyword. Guarded to chiller keywords/codes only
    //   so it won't collide with APMR/APMR-A/PAC4A routing. Returns null for a
    //   bare series name (e.g. "APCY-H") so the catalogue/IOM flow still handles it.
    const chillerResp = routeChillerText(text);
    if (chillerResp) {
      console.log(`❄️ Chiller intent (${chillerResp.type}) for "${text}"`);
      return await sendChillerResponse(from, chillerResp);
    }

    // 1a) DATASHEET request: "APMR 52300 datasheet" (series + 5-digit code,
    //     with "datasheet"/"spec" or a T1/T3). Fetches from the series'
    //     Datasheets subfolder. Two files (T1+T3) -> ask which; one -> send it.
    //     Must run BEFORE the TR/CFM selection logic, which also sees codes.
    const dsReq = parseDatasheetRequest(text);
    if (dsReq) {
      console.log(`📄 Datasheet request: ${dsReq.series} ${dsReq.code} ${dsReq.condition || ""}${dsReq.explicit ? "" : " (implicit)"}`);
      await announceSearch("🔍 Looking up that datasheet…");
      const files = await listFolderFiles();
      const matches = findDatasheetFiles(dsReq.series, dsReq.code, files);

      if (matches.length) {
        // If the user already specified a condition, try to honour it directly.
        if (dsReq.condition) {
          const exact = matches.find((m) => m.condition === dsReq.condition);
          if (exact) {
            const file = files.find((f) => f.id === exact.id);
            if (file) return await sendDriveFile(from, file);
          }
        }

        // Single file (e.g. PAC4A has no T1/T3) -> send it directly.
        if (matches.length === 1) {
          const file = files.find((f) => f.id === matches[0].id);
          if (file) return await sendDriveFile(from, file);
        }

        // Multiple files (T1 + T3) -> ask which condition via buttons.
        const menu = datasheetMenu(dsReq.series, dsReq.code, matches);
        return await sendButtons(from, menu.text, menu.buttons);
      }

      // No datasheet on file for this code. If the user explicitly asked for a
      // datasheet (word "datasheet"/spec or a T1/T3), say so. If it was just
      // "<series> <code>", fall through so the rest of the pipeline can try.
      if (dsReq.explicit) {
        return await sendNotFoundByName(from, text, files);
      }
    }

    // 1) Product selection by tonnage or CFM (e.g. "package unit 20 tr t3",
    //    "5000 cfm package unit"). This must run BEFORE generic sheet keyword
    //    rules, otherwise a broad keyword like "packaged" would intercept it.
    const selection = buildSelectionInteractive(text);
    if (selection) {
      console.log(`📐 Selection request: "${text}"`);
      return await sendButtons(from, selection.text, selection.buttons);
    }

    // 1b) Series request (no number): "APMR" -> ask Catalogue or IOM;
    //     "APMR IOM" / "apmra catalogue" -> fetch directly from that folder.
    const seriesReq = parseSeriesRequest(text);
    if (seriesReq) {
      if (seriesReq.mode === "menu") {
        // "fcu" is a menu request. "fcu coil connection sheet" is a SEARCH —
        // the series detector sees only "fcu" and would throw the rest away,
        // offering Catalogue/IOM for a document that is neither. Look across
        // the whole index first; fall through to the menu if nothing matches,
        // so this can only ever add a result, never remove one.
        if (hasSearchableExtras(text, seriesReq.series)) {
          const allFiles = await listFolderFiles();
          const named = findFilesByName(text, allFiles);
          if (named.length) {
            console.log(`🗂️  Name match beat the series menu: "${text}" -> ${named.map((f) => f.name).join(", ")}`);
            return await sendFileOptions(from, named, `Here's what I found for "${text}":`);
          }
          const ranked = rankFiles(text, allFiles, 10);
          if (ranked.length) {
            console.log(`🗂️  Ranked match beat the series menu: "${text}" -> ${ranked.length} hit(s)`);
            return await sendFileOptions(from, ranked,
              `Closest matches for "${text}":`, false);
          }
        }

        const menu = seriesMenu(seriesReq.series);
        // Only one document type exists -> send it directly, no extra tap.
        if (menu.only) {
          console.log(`📚 Series single-doc: ${menu.only.series} ${menu.only.docType}`);
          await announceSearch("🔍 Fetching that document…");
          const file = await resolveSeriesFile(menu.only.series, menu.only.docType, listFolderFiles);
          if (file) return await sendDriveFile(from, file);
          return await sendNotFoundByName(from, text);
        }
        // No buttons (nothing on file) -> just send the text.
        if (!menu.buttons || !menu.buttons.length) {
          return await sendText(from, menu.text);
        }
        console.log(`📚 Series menu: ${seriesReq.series}`);
        return await sendButtons(from, `${menu.text}\n\n${escapeHatchHint()}`, menu.buttons);
      }
      // direct: user named both series and doc type
      console.log(`📚 Series direct: ${seriesReq.series} ${seriesReq.docType}`);
      await announceSearch("🔍 Fetching that document…");
      const file = await resolveSeriesFile(seriesReq.series, seriesReq.docType, listFolderFiles);
      if (file) return await sendDriveFile(from, file);
      return await sendNotFoundByName(from, text);
    }

    // From here it is a free-form document lookup (bare code, filename, brand, or
    // words that name no series). A written question lands here too: it is looked
    // for as a file name like anything else, and nothing answers it in words.
    await announceSearch();

    const files = await listFolderFiles();

    // 1c) Bare product code (e.g. "52015"). A code can mean more than one thing
    //     (a PAC4A fresh-air selection PDF, and/or an APMR-A packaged model).
    //     If the user added context words, use them; otherwise disambiguate.
    const codeInfo = interpretCode(text);
    if (codeInfo) {
      const t = text.toLowerCase();
      const wantsFresh = /fresh air|doas|pac4a|outside air/.test(t);
      const wantsPackaged = /packaged|package unit|apmr|standard/.test(t);

      let chosen = null;
      if (codeInfo.meanings.length === 1) {
        chosen = codeInfo.meanings[0];
      } else if (wantsFresh) {
        chosen = codeInfo.meanings.find((m) => m.type === "pac4a_selection");
      } else if (wantsPackaged) {
        chosen = codeInfo.meanings.find((m) => m.type === "apmr_model");
      }

      if (chosen) {
        if (chosen.type === "pac4a_selection") {
          const hit = findFilesByName(chosen.fetch, files);
          if (hit.length === 1) return await sendDriveFile(from, hit[0]);
        } else if (chosen.type === "apmr_model") {
          const hit = findFilesByName("apmr-a", files);
          if (hit.length >= 1) return await sendDriveFile(from, hit[0]);
        }
      }

      // Ambiguous: ask the user which one.
      if (codeInfo.meanings.length > 1 && !chosen) {
        const opts = codeInfo.meanings
          .map((m) =>
            m.type === "pac4a_selection"
              ? `• Reply "${codeInfo.code} fresh air" — ${m.label}`
              : `• Reply "${codeInfo.code} packaged" — ${m.label}`
          )
          .join("\n");
        return await sendText(
          from,
          `"${codeInfo.code}" matches more than one product. Which do you want?\n${opts}`
        );
      }
    }

    // If the user's message mentions a doc type (IOM / catalogue), restrict search
    // to only files of that type so "AHU IOM" never lists catalogue files.
    const mentionedDocType = detectDocType(text); // "IOM", "Catalogue", or null
    const searchFiles = mentionedDocType
      ? files.filter((f) => fileMatchesDocType(f, mentionedDocType))
      : files;

    // 2) Exact filename search (fast, free) — works for codes & names.
    const hits = findFilesByName(text, searchFiles);
    console.log(`🔎 Folder search "${text}" [${mentionedDocType || "all"}]: ${hits.length} hit(s)`);
    if (hits.length >= 1) return await sendFileOptions(from, hits, "I found a few matches:");

    // 2b) Brand-docs map lookup — direct keyword→filename match, no AI needed.
    //     Covers third-party brands (Hisense, Daikin, etc.) and any doc added to brand-docs.js.
    if (!hits.length) {
      const brandMatches = findBrandDocs(text, mentionedDocType);
      console.log(`📚 brand-docs lookup "${text}" [${mentionedDocType || "all"}]: ${brandMatches.length} match(es)`);
      if (brandMatches.length) {
        // Resolve each matched filename against the Drive file index.
        // Use flexible matching: strip extension + separators, then check if
        // one normalized string contains the other (handles extra year/suffix in filename).
        const normStr = (s) => (s || "").toLowerCase().replace(/\.[^.]+$/, "").replace(/[\s\-_.]/g, "");
        const resolved = [];
        for (const { entry, file } of brandMatches) {
          const needle = normStr(file.filename);
          const found = files.find((f) => {
            const hay = normStr(f.name);
            return hay === needle || hay.includes(needle) || needle.includes(hay);
          });
          if (found) resolved.push(found);
          else console.log(`⚠️  brand-docs: "${file.filename}" not found in Drive index`);
        }
        if (resolved.length === 1) return await sendDriveFile(from, resolved[0]);
        if (resolved.length > 1) return await sendFileOptions(from, resolved, "Here are the matching documents:");
        // filename listed in brand-docs.js but not yet on Drive
        return await sendNotFoundByName(from, text, files);
      }
    }

    // 3) Nothing matched -> close names, then AI suggests related documents, or the Request it button
    await sendNotFoundByName(from, text, files);
}

// ── Bot Sender app API ──────────────────────────────────────────────────────
// Lets the owner's Android app send messages as the bot. Off unless
// SENDER_PIN is set. Delivery results arrive via the webhook's `statuses`.
const senderStatus = createStatusStore();
if (WA_ON) app.use("/api/sender", createSenderRouter({
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
  searchFiles: async (q) => {
    const files = await listFolderFiles();
    const named = findFilesByName(q, files);
    return (named.length ? named : rankFiles(q, files, 20)).slice(0, 20).map((f) => ({ id: f.id, name: f.name, folder: f.folder || "" }));
  },
  findFileById: async (id) => (await listFolderFiles()).find((f) => f.id === id) || null,
  uploadDriveFile: (f) => wa.uploadMedia({ fileId: f.id, filename: f.name, exportMime: f.exportMime }),
  uploadStream: wa.uploadMediaStream,
  sendDocument: wa.sendDocumentDetailed,
}));

// One inbound message, start to finish: queued per user, Allowed check, the
// channel it arrived on, the handler, and the apology on a crash. Conversation
// state is saved afterwards, in a finally, so a crash doesn't lose it. The
// webhook calls this with the WhatsApp adapter; the web chat will inject its own.
function deliverMessage(value, message, adapter) {
  return enqueue(message.from, () => runWithChannel(adapter, async () => {
    let account = null;
    try {
      // Resolve who's asking and pin it to this request's async context, so
      // every nested Claude call knows their plan without a threaded flag.
      // loadSheet() is cached for CACHE_MS, so this lookup is effectively free.
      // Not on the Allowed tab (or the tab is empty) -> no reply at all.
      const { accounts } = await loadSheet();
      account = findAccount(message.from, accounts);
      if (!account) {
        console.log(`Ignored non-allowed: ${message.from}`);
        return;
      }
      await runWithAccount(account, () => handleIncomingMessage(value, message));
    } catch (err) {
      console.error("Handler error:", err.stack || err.message);
      // Never leave an allowed user with silence on a crash. Strangers get nothing.
      if (!account) return;
      try {
        await sendText(message.from, "⚠️ Something went wrong on my side. Please try that again — or type *menu* to see what I can do.");
      } catch (_) { /* the apology itself failed; nothing more to do */ }
    } finally {
      // Save the user's conversation so it survives a restart. A failure here
      // is logged and never breaks the reply that was already sent.
      if (account) {
        try { store.persist(message.from); }
        catch (err) { console.error("State save failed:", err.message); }
      }
    }
  }));
}

if (WA_ON) app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  for (const line of metaEventLines(req.body)) console.log(line);
  const value = req.body.entry?.[0]?.changes?.[0]?.value;
  for (const s of value?.statuses || []) senderStatus.record(s);
  const message = value?.messages?.[0];
  if (!message) return;

  // Drop WhatsApp retries (same message.id re-delivered during cold start).
  if (message.id && isDuplicate(message.id)) {
    console.log(`⚡ Duplicate message ${message.id} — skipped`);
    return;
  }

  // WhatsApp is the channel for everything under the webhook, the apology too.
  deliverMessage(value, message, whatsappAdapter);
});

app.get("/", (_, res) => res.send("HVAC Assistant is running ✅"));

// The web app lives under /app and nothing else is served from there. Signing in
// uses a personal link (web/auth.js). mountWeb puts the sign-in pages and then a
// sign-in check in front of EVERYTHING under /app, so any route added below is
// closed by default; with no usable WEB_SECRET every /app request is a 503.
// Anything public (share links) must be mounted outside /app.
mountWeb(app, { secret: process.env.WEB_SECRET, getAccounts: async () => (await loadSheet()).accounts });

// The first time someone opens an empty chat the bot says what typing "menu"
// says: same code, through the web channel, queued like any other message.
function deliverWelcome(account) {
  return enqueue(account.number, () => runWithChannel(webChannel, () => runWithAccount(account, async () => {
    try { await showWelcomeMenu(account.number, account.name); }
    finally {
      try { store.persist(account.number); }
      catch (err) { console.error("State save failed:", err.message); }
    }
  })));
}
// The chat API, files and share links (web/routes.js). The router goes
// after mountWeb, so everything under /app is already behind the sign-in check;
// /s/<token> is outside /app and public by design.
app.use(createWebRoutes({
  deliverMessage, conversations: webConversations, webChannel,
  sendWelcome: deliverWelcome,
  getFile: async (id) => {
    if (!process.env.DRIVE_FOLDER_ID) return null;
    const lib = require("./lib/drive-index.js").getLibraryIndex();
    return lib.findById(id) || (await lib.list(), lib.findById(id));
  },
  secret: process.env.WEB_SECRET,
  publicUrl: process.env.PUBLIC_URL,
}));
app.use("/app", webErrorHandler); // a body that isn't JSON fails before the router, as JSON

// Temporary: list all indexed Drive files so we can update brand-docs.js
// /drive-index            -> everything the bot can see
// /drive-index?q=coil     -> only files/folders matching "coil" (diagnosing
//                            "why can't the bot find X?" without scrolling)
app.get("/drive-index", requireAdmin(), async (req, res) => {
  try {
    const all = await listFolderFiles();
    const q = String(req.query.q || "").toLowerCase().trim();
    const files = q
      ? all.filter((f) => `${f.folder}/${f.name}`.toLowerCase().includes(q))
      : all;
    if (q && !files.length) {
      return res.type("text/plain").send(
        `No indexed file matches "${q}".\n\n` +
        `The index holds ${all.length} files. If the document exists in Drive but ` +
        `isn't here, it is either a native Google Doc/Sheet (needs an export, not ` +
        `indexed), an unsupported type, or outside DRIVE_FOLDER_ID.\n`
      );
    }
    const grouped = {};
    for (const f of files) {
      if (!grouped[f.folder]) grouped[f.folder] = [];
      grouped[f.folder].push(f.name);
    }
    let out = q
      ? `Matching "${q}": ${files.length} of ${all.length} indexed files\n\n`
      : `Total: ${files.length} files\n\n`;
    for (const [folder, names] of Object.entries(grouped).sort()) {
      out += `📁 ${folder}\n`;
      for (const n of names.sort()) out += `   ${n}\n`;
      out += "\n";
    }
    res.type("text/plain").send(out);
  } catch (e) {
    res.status(500).send("Error: " + e.message);
  }
});
crm.init({ getSheets });

// Last in line, for every route: whatever NODE_ENV is, an error answers with a
// short JSON message and never Express's default page, which carries a stack
// trace and file paths. (A body that isn't JSON fails in express.json() before
// any route is reached.)
app.use(webErrorHandler);

// The replay test (tests/replay) imports this file: it gets the app and the
// message handler, and nothing listens, ticks or calls out until it's run.
module.exports = { app, handleIncomingMessage, deliverMessage, resolveSeriesFile };

if (require.main === module) {
  try { store.restore(); } // bring back conversations saved before the last restart
  catch (err) { console.error("State restore failed:", err.message); }
  crm.warmUp(); // preload contacts so "Welcome back" works from the first message
  app.listen(PORT, () => {
    console.log(`🚀 Listening on ${PORT}`);
    if (numberHealth) {
      numberHealth.maybeCheck();
      setInterval(() => numberHealth.maybeCheck(), CHECK_EVERY_MS).unref();
    }
  });
}
