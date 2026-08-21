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
//  WhatsApp Auto-Responder + Claude Haiku AI Fallback
//  - Google Sheet = control panel (rules + AI knowledge)
//  - Keyword rules answer common questions for FREE
//  - Claude Haiku answers everything else using YOUR knowledge only
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
const { hasSearchableExtras, rankFiles, isSearchAllTrigger, SEARCH_ALL_HINT, isAiSearchTrigger, AI_SEARCH_HINT } = require("./lib/broad-search.js");
const { isCreditError, markExhausted, isExhausted, creditsExhaustedMessage } = require("./lib/ai-credits.js");
const { parseAccounts, runWithAccount, currentAccount, aiAllowed, freePlanMessage } = require("./lib/accounts.js");
const { parseRelatedFilesResponse } = require("./lib/related-files.js");
const { isMenuTrigger, smallTalkReply, welcomeMenu, welcomeMenuList, tipFor, MENU_HINT } = require("./menu.js");
const { PRODUCT_KB, parseListRequest, parseUnsupportedSeriesListRequest, buildUnitList } = require("./product-facts.js");
const crm = require("./crm.js");
const { generateMtzPdf } = require("./mtz-pdf.js");
const schedule = require("./schedule-select.js");
const { FAMILY_MENU, rankSplit, parseSplitListRequest, listSplits } = require("./split-engine.js");
const { generateSplitPdf } = require("./split-pdf.js");
const { generateSchedulePdf } = require("./schedule-pdf.js");
const { isVrfTrigger } = require("./vrf/trigger.js");
const {
  initVrf, onVrfKeyword, onVrfMessage, sessions: vrfSessions,
} = require("./vrf/vrfHandler.js");
const { getSheets, getDrive, withRetry, driveFileId, downloadBytes, normalizeDriveLink } = require("./lib/google.js");
const {
  listFolderFiles, docTypeFromFilename, folderMatchesDocType, fileMatchesDocType,
  findFilesInFolder, findExactFileInDoc, findDatasheetFiles, findChillerDatasheetFiles, displayName,
} = require("./lib/drive-index.js");
const wa = require("./lib/wa.js");
const {
  send, sendText, sendLongText, sendButtons, sendList, sendDocument, sendDriveFile,
  sendPdfBuffer, uploadMedia, uploadMediaBuffer, downloadWhatsAppMedia, markReadWithTyping,
  NOT_FOUND_MSG, fileTooLargeMessage, WHATSAPP_MAX_FILE_BYTES, validatePdfBuffer,
} = wa;

const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  ANTHROPIC_API_KEY,
  GOOGLE_SHEET_ID,
  PORT = 3000,
} = process.env;

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

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ============================================================
//  GOOGLE SHEET ACCESS
//  Sheet has 3 tabs:
//   1) "Rules"     -> Keywords | Match | Type | Caption | FileLink | Filename
//   2) "Knowledge" -> Topic | Info   (the AI's knowledge base)
//   3) "Allowed"   -> Number        (optional whitelist; empty = reply to all)
// ============================================================
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

// Unified per-user session state (guided flows + auxiliary ctx). Replaces the
// 8 previous ad-hoc per-user stores that each had their own TTL and expiry logic.
const store = require("./lib/session-store.js");
const { enqueue } = require("./lib/user-queue.js");

const VRF_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

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


// Simple cache so we don't hit the Sheet on every single message
let cache = { rules: [], knowledge: [], allowed: [], accounts: new Map(), ts: 0 };
const CACHE_MS = 60 * 1000; // refresh at most once per minute

async function loadSheet() {
  if (Date.now() - cache.ts < CACHE_MS && cache.rules.length) return cache;

  const sheets = await getSheets();
  // Allowed is A2:C — A = number, B = name, C = plan (paid/free). Extra
  // columns are additive: rows that only fill A keep working as before.
  const ranges = ["Rules!A2:F", "Knowledge!A2:B", "Allowed!A2:C"];
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: GOOGLE_SHEET_ID,
    ranges,
  });

  const [rulesRows, knowRows, allowRows] = res.data.valueRanges.map(
    (r) => r.values || []
  );

  const rules = rulesRows
    .filter((r) => r[0]) // must have keywords
    .map((r) => ({
      keywords: (r[0] || "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean),
      matchType: (r[1] || "contains").trim().toLowerCase(),
      type: (r[2] || "text").trim().toLowerCase(),
      caption: r[3] || "",
      fileLink: normalizeDriveLink(r[4] || ""),
      filename: r[5] || "file.pdf",
    }));

  const knowledge = knowRows
    .filter((r) => r[0] || r[1])
    .map((r) => `${r[0] ? r[0] + ": " : ""}${r[1] || ""}`);

  // accounts carries name + plan per number; `allowed` stays the plain list of
  // numbers so the existing gate below is untouched.
  const accounts = parseAccounts(allowRows);
  const allowed = [...accounts.keys()];

  cache = { rules, knowledge, allowed, accounts, ts: Date.now() };
  const paidCount = [...accounts.values()].filter((a) => a.paid).length;
  console.log(
    `🔄 Sheet loaded: ${rules.length} rules, ${knowledge.length} knowledge rows, ` +
    `${accounts.size} account(s) (${paidCount} paid)`
  );
  return cache;
}

// ============================================================
//  MATCHING
// ============================================================
function matchRule(text, rules) {
  const t = text.trim().toLowerCase();
  for (const rule of rules) {
    if (rule.matchType === "exact") {
      if (rule.keywords.some((k) => t === k)) return rule;
    } else {
      if (rule.keywords.some((k) => t.includes(k))) return rule;
    }
  }
  return null;
}

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

// The bot's full menu of capabilities, in copy-paste command form. Shown as the
// last-resort reply when a request matches nothing AND the AI can't even guess
// which product the user meant. Also handed to the AI in aiGuidance() as the
// authoritative list of commands it may suggest (so it never invents one).
const BOT_CAPABILITIES =
  "Here's everything I can help you with 👇\n\n" +
  "*📄 Documents*\n" +
  "• Catalogue — e.g. *APMR catalogue*, *Hisense catalogue*\n" +
  "• IOM manual — e.g. *APMR IOM*\n" +
  "• Model datasheet — e.g. *APMRa 51004*, *APMR 52340 T1*\n" +
  "• List a full range — e.g. *list APMR units*, *list of split units*\n\n" +
  "*🛠️ Quick Selection* (give a capacity → get a model)\n" +
  "• Packaged unit — *package unit 20 tr t3*\n" +
  "• Fresh air / DOAS — *fresh air 15 tr*\n" +
  "• Chiller — *APCY-H 30 tr*\n" +
  "• Fan coil unit — *DMP 10 tr*\n\n" +
  "*🧭 Guided Selectors* (step-by-step + PDF)\n" +
  "• *Schedule Selection* · *VRF Selection* · *MTZ Selection* · *Split Selection*\n\n" +
  "💡 Type *menu* anytime, or email hassan.saleem@mannai.com.qa for help.";

// ============================================================
//  CLAUDE HAIKU FALLBACK
//  Answers ONLY from the Knowledge tab. Refuses to invent.
// ============================================================
async function askClaude(question, knowledge) {
  if (!ANTHROPIC_API_KEY || isExhausted() || !aiAllowed()) return null;

  const knowledgeText = knowledge.join("\n");

  // System prompt in two blocks: the big static block (instructions + product
  // specs, ~5K tokens) goes FIRST and is prompt-cached — repeat questions
  // within 5 minutes read it at ~10% of the normal input price. The small
  // dynamic Sheet knowledge follows, outside the cached prefix.
  const staticBlock = `You are a helpful WhatsApp assistant for an HVAC equipment supplier.
Answer the customer's question using ONLY the information provided (product specifications below + business info that follows).
Keep replies short, friendly, and suitable for WhatsApp (2-4 sentences max).
When quoting a product spec, give the exact figure and its units, and name the model (e.g. "APMR 52340 at T3: 24.9 TR / 87.6 kW, 10500 CFM").
If the information does not contain the answer, reply exactly:
"Let me connect you with a team member who can help with that."
Do NOT make up prices, products, capacities, or details — only use the numbers given.

--- PRODUCT SPECIFICATIONS ---
${PRODUCT_KB}
--- END SPECIFICATIONS ---`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: [
        { type: "text", text: staticBlock, cache_control: { type: "ephemeral" } },
        { type: "text", text: `--- BUSINESS INFORMATION ---\n${knowledgeText}\n--- END INFORMATION ---` },
      ],
      messages: [{ role: "user", content: question }],
    });
    return msg.content?.[0]?.text?.trim() || null;
  } catch (err) {
    console.error("Claude error:", err.message);
    if (isCreditError(err)) markExhausted();
    return null;
  }
}

// Use Claude to match a user's request to the best file when filename search
// misses (handles synonyms, e.g. "AHU" / "air handling unit" -> MAH.pdf).
// Returns the matching file object, or null if none fits.
async function aiMatchFile(text, files) {
  if (!ANTHROPIC_API_KEY || isExhausted() || !aiAllowed() || !files.length) return null;

  // Give Claude the list of filenames (without extension) to choose from.
  const list = files.map((f, i) => `${i + 1}. ${f.name.replace(/\.[^.]+$/, "")}`).join("\n");

  const system = `You match a customer's request to ONE or more HVAC product files from a list.
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

Reply with ONLY the number of the single best matching file.
If several are equally valid (e.g. user said "chiller" and there are several), reply with their numbers separated by commas.
If nothing matches, reply with "0".
No other text.

FILES:
${list}`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 30,
      system,
      messages: [{ role: "user", content: text }],
    });
    const out = (msg.content?.[0]?.text || "").trim();
    const nums = out.match(/\d+/g);
    if (!nums) return null;
    const picked = nums
      .map((n) => parseInt(n, 10))
      .filter((n) => n >= 1 && n <= files.length)
      .map((n) => files[n - 1]);
    return picked.length ? picked : null; // array of matches
  } catch (err) {
    console.error("AI match error:", err.message);
    if (isCreditError(err)) markExhausted();
    return null;
  }
}

// AI fallback for a lookup miss: finds documents that are genuinely relevant
// to the request (not just loosely related) so a not-found reply can offer
// alternatives instead of a dead end. Returns [] (never null) when nothing
// clears the relevance bar, so callers can do `if (hits.length)` directly.
async function aiRelatedFiles(text, files) {
  if (!ANTHROPIC_API_KEY || isExhausted() || !aiAllowed() || !files.length) return [];

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

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 40,
      system,
      messages: [{ role: "user", content: text }],
    });
    const out = (msg.content?.[0]?.text || "").trim();
    return parseRelatedFilesResponse(out, files);
  } catch (err) {
    console.error("AI related-files error:", err.message);
    if (isCreditError(err)) markExhausted();
    return [];
  }
}

// Last-resort "smart guidance" for a request that matched no file. Given the
// raw message, the AI either (a) recognises the product/brand/intent and
// replies with a short, human-like note naming the EXACT commands that would
// work for it (e.g. "SKM package selection" -> how to get the catalogue, IOM,
// datasheet, run a selection, or list the range), or (b) can't make sense of
// it and returns the sentinel "SHOW_MENU". Returns the guidance string, or
// null when the caller should fall back to the full capabilities menu.
async function aiGuidance(text) {
  if (!ANTHROPIC_API_KEY || isExhausted() || !aiAllowed()) return null;

  const system = `You are the Mannai HVAC WhatsApp assistant. A customer's message did NOT match any document or command. Act like a helpful human colleague: figure out what they probably want and point them to a command that actually works.

These are the ONLY real things the bot can do — never invent a command, model number, or capability outside this list:
${BOT_CAPABILITIES}

HVAC abbreviations & brands you should recognise:
- APMR / APMR-A / APMR-V = SKM packaged air conditioners
- PAC4A / PAC9A = 100% fresh-air / DOAS packaged units
- APCY-E / APCY-H / APCY-P / ACMR / WPCY = chillers
- MAH / CAH / HMAH = air handling units (AHU)
- FCU / DMP / DCMP = fan coil units
- VRF / VRV = variable refrigerant flow multi-split
- MTZ = Trane packaged unit
- Brands: SKM, Hisense, Daikin, Mitsubishi, Trane, Toshiba, TCL

RULES:
- If you can reasonably tell which product, brand, or intent the customer means, reply with a SHORT, warm message (2–5 short lines). Name the product, then list ONLY the commands that make sense for it, each as an exact phrase in *asterisks* the customer can copy and send.
- If the message is too vague, or not about HVAC products/documents at all, reply with EXACTLY: SHOW_MENU
- NEVER claim a document was sent. NEVER give specs, prices, or capacities. You only guide.
- No "Hello"/greetings — go straight to the helpful guidance.`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 250,
      system,
      messages: [{ role: "user", content: text }],
    });
    const out = (msg.content?.[0]?.text || "").trim();
    if (!out || /^SHOW_MENU$/i.test(out)) return null;
    return out;
  } catch (err) {
    console.error("AI guidance error:", err.message);
    if (isCreditError(err)) markExhausted();
    return null;
  }
}

// AI-pick the single file in a folder that matches a requested SERIES.
// Used as a fallback for the Catalogue/IOM flow when the deterministic
// prefix matcher misses because files are named inconsistently
// (e.g. "FCU Catalogue.pdf", "APMR-A. 2025.pdf", "APMRA 2025 IOM.pdf").
// `folderFiles` are already filtered to the right folder.
// Returns one file object, or null.
async function aiMatchSeriesFile(series, docType, folderFiles) {
  if (!ANTHROPIC_API_KEY || isExhausted() || !aiAllowed() || !folderFiles.length) return null;

  const list = folderFiles
    .map((f, i) => `${i + 1}. ${f.name.replace(/\.[^.]+$/, "")}`)
    .join("\n");

  const system = `You match a requested SKM HVAC product SERIES to ONE file from a list of ${docType} files.
The customer wants the ${docType} for series: "${series}".

Rules:
- Pick the file whose name refers to the SAME product series, ignoring extra tokens like a year (2025), version, brand word ("SKM"), the word "${docType}", spaces, dots and dashes.
- Be STRICT about the series identity. "APMR", "APMR-A" and "APMR-V" are DIFFERENT series — do not confuse them. "APCY-P", "APCY-H", "APCY-E" are different. "ACUV-D" vs "ACUV-S" are different.
- If two files fit equally (e.g. "APMR-A.pdf" and "APMR-A. 2025.pdf"), pick the one WITHOUT a year/version (the generic latest).
- If NO file matches the series, reply "0".

Reply with ONLY the number of the single best file, or "0". No other text.

FILES:
${list}`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      system,
      messages: [{ role: "user", content: `${series} ${docType}` }],
    });
    const out = (msg.content?.[0]?.text || "").trim();
    const n = parseInt((out.match(/\d+/) || [])[0], 10);
    if (!n || n < 1 || n > folderFiles.length) return null;
    return folderFiles[n - 1];
  } catch (err) {
    console.error("AI series-match error:", err.message);
    if (isCreditError(err)) markExhausted();
    return null;
  }
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

  // 2) No map entry at all — safety net: old prefix matcher, then AI.
  const files = await getFiles();
  return await fallbackResolve(seriesNameOrText, docType, files);
}

// Safety net for series with no map entry, or where the map's expected
// filename wasn't found live (renamed/removed in Drive since last cache build).
async function fallbackResolve(seriesNameOrText, docType, files) {
  const hits = findFilesInFolder(seriesNameOrText, files, docType);
  if (hits.length >= 1) return hits[0];

  const folderFiles = files.filter((f) => folderMatchesDocType(f.folder, docType));
  if (!folderFiles.length) return null;
  const ai = await aiMatchSeriesFile(seriesNameOrText, docType, folderFiles);
  if (ai) console.log(`🤖 AI matched ${seriesNameOrText} ${docType} -> ${ai.name}`);
  return ai;
}

// ============================================================
//  SENDING
// ============================================================
// send/sendText/sendLongText/sendButtons/sendDocument/sendDriveFile/sendPdfBuffer
// now live in lib/wa.js (imported above).

// Send a unit list (split or product) in the chosen unit system, then a small
// button message offering to switch Imperial <-> International. The list itself
// can exceed the 1024-char interactive-body limit, so it goes as plain text
// (sendLongText) and the toggle rides in a separate button message.
//   system: "si"  = International (kW, m³/h) · "imp" = Imperial (TR, CFM)
async function sendListWithToggle(from, kind, keys, system) {
  const body = kind === "split" ? listSplits(keys, system) : buildUnitList(keys, system);
  if (!body) return;
  await sendLongText(from, body);
  store.setCtx(from, "unitList", { kind, keys, system }, 30 * 60 * 1000);
  const other = system === "si" ? "imp" : "si";
  const curName = system === "si" ? "International (kW)" : "Imperial (TR)";
  const otherTitle = other === "si" ? "International (kW)" : "Imperial (TR)";
  await sendButtons(
    from,
    `📐 Showing in *${curName}*. Tap to switch units:`,
    [{ id: `units|${other}`, title: otherTitle }]
  );
}

// uploadMedia/uploadMediaBuffer/downloadWhatsAppMedia/mimeFromName/validatePdfBuffer
// and sendDocument/sendDriveFile/sendPdfBuffer now live in lib/wa.js (imported above).

async function sendRule(to, rule) {
  if (rule.type === "document") {
    let buffer;
    try {
      buffer = await downloadBytes({ link: rule.fileLink });
      validatePdfBuffer(buffer, rule.filename);
    } catch (err) {
      console.error("❌ Document download error:", err.message);
      return sendText(to, NOT_FOUND_MSG);
    }
    try {
      const mediaId = await uploadMediaBuffer(buffer, rule.filename);
      return send(to, {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: { id: mediaId, filename: rule.filename, caption: rule.caption },
      });
    } catch (err) {
      console.error("❌ Document upload error:", err.response?.data || err.message);
      if (err.response?.status === 413 || buffer.length > WHATSAPP_MAX_FILE_BYTES) {
        return sendText(to, fileTooLargeMessage(rule.filename));
      }
      return sendText(to, NOT_FOUND_MSG);
    }
  }
  if (rule.type === "image") {
    try {
      const mediaId = await uploadMedia({ link: rule.fileLink, filename: rule.filename || "image.jpg" });
      return send(to, {
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: { id: mediaId, caption: rule.caption },
      });
    } catch (err) {
      console.error("❌ Image upload error:", err.response?.data || err.message);
      return sendText(to, `Sorry, I couldn't fetch that image right now.`);
    }
  }
  return sendText(to, rule.caption);
}

// send() now lives in lib/wa.js (imported above).

// ============================================================
//  WEBHOOK VERIFY
// ============================================================
app.get("/webhook", (req, res) => {
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
// Both escape hatches, in cost order. The AI one is only advertised to
// accounts entitled to it — offering a free account a button that returns the
// upgrade message is a worse experience than not offering it.
function escapeHatchHint() {
  return aiAllowed() ? `${SEARCH_ALL_HINT}\n${AI_SEARCH_HINT}` : SEARCH_ALL_HINT;
}

async function sendFileOptions(to, matchedFiles, prompt, autoSendSingle = true) {
  if (autoSendSingle && matchedFiles.length === 1) return sendDriveFile(to, matchedFiles[0]);

  // autoSendSingle === false means these are GUESSES, not a confident match.
  // Whenever we're guessing, offer BOTH escape hatches so the user can jump
  // straight to AI instead of being made to try the free scan first.
  if (!autoSendSingle) prompt = `${prompt || "I found several matches:"}\n\n${escapeHatchHint()}`;

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
      description: displayName(f).length > 24 ? f.name : undefined,
    }));
    return sendList(to, prompt || "I found several matches:", "Choose a document", rows);
  }

  // 11+ matches: numbered text list stored for the next reply.
  store.clearCtx(to, "menu");
  store.setCtx(to, "list", matchedFiles, 30 * 60 * 1000);
  const list = matchedFiles.map((f, i) => `${i + 1}. ${displayName(f)}`).join("\n");
  return sendText(to, `${prompt || "I found several matches:"}\n\n${list}\n\nReply with a number to get the file.`);
}

// Last-resort reply for a lookup miss: ask AI for documents that are
// genuinely relevant to the request and offer them as a caveated choice
// (never auto-sent — a related match is a guess, not a confirmed answer).
// Falls back to the plain NOT_FOUND_MSG when nothing clears the relevance
// bar. `files` is optional — pass the already-fetched Drive index when the
// caller has one in scope; otherwise it's fetched here (cheap:
// listFolderFiles() caches for FILE_CACHE_MS).
async function sendNotFoundWithSuggestions(to, text, files) {
  // Free account: the steps below are all Claude calls this number isn't
  // entitled to, so they'd return empty and dump the user on a generic menu.
  // Tell them why and point at the exact-filename path, which still works.
  if (!aiAllowed()) {
    const account = currentAccount();
    console.log(`🔒 Free account ${account?.number} -> upgrade message for "${text}"`);
    return sendText(to, freePlanMessage(account?.name));
  }

  // Paid account, but the Anthropic balance is empty: every step below is a
  // Claude call that would fail, leaving the user on a generic menu with no
  // explanation. Say the credits are gone and point at the exact-filename
  // path, which is pure filename matching and still works.
  if (isExhausted()) {
    console.log(`💳 AI credits exhausted -> credits message for "${text}"`);
    return sendText(to, creditsExhaustedMessage(currentAccount()?.name));
  }

  const fileList = files || (await listFolderFiles());
  const hits = await aiRelatedFiles(text, fileList);
  console.log(`🔎 Related-files fallback for "${text}": ${hits.length} suggestion(s)`);
  if (hits.length) {
    const caveat = `I couldn't find an exact match for "${text}". We might not have that exact document, but here are the closest ones I have — pick one below. If none fit, email hassan.saleem@mannai.com.qa.`;
    return sendFileOptions(to, hits, caveat, false);
  }

  // No related files either. Instead of a flat "not found", let the AI give a
  // human-like reply that steers the user to a command that works (e.g. they
  // typed "SKM package selection" -> tell them how to get the catalogue, IOM,
  // datasheet, run a selection, or list the range). If even the AI can't tell
  // what they meant, fall back to the full capabilities menu.
  // Nothing confident to offer. Before falling back to generic guidance or the
  // capabilities menu, try the free ranked scan of the WHOLE index — it costs
  // nothing and reaches folders (Submittal Files etc.) the doc-type paths miss.
  const ranked = rankFiles(text, fileList, 10);
  if (ranked.length) {
    console.log(`🗂️  Ranked fallback for "${text}": ${ranked.length} hit(s)`);
    return sendFileOptions(to, ranked, `Closest matches for "${text}":`, false);
  }

  const guidance = await aiGuidance(text);
  if (guidance) {
    console.log(`🧭 Smart guidance for "${text}"`);
    return sendText(to, `${guidance}\n\n${MENU_HINT}\n\n${escapeHatchHint()}`);
  }
  console.log(`📋 No guess for "${text}" -> capabilities menu`);
  return sendText(to, `${BOT_CAPABILITIES}\n\n${escapeHatchHint()}`);
}


// ============================================================
//  SPLIT UNIT SELECTION HANDLER (Toshiba / TCL / SKM)
// ============================================================

const SPLIT_BRANDS = [
  { name: "Toshiba", types: [
    { label: "Hi-Wall (RAS-18/24/30PKV)",         famKey: "PKV", kind: "grid" },
    { label: "Ducted Non-Inverter (RAV BSP/ASP)",  famKey: "BSP", kind: "grid" },
    { label: "Ducted Inverter (RAV SH)",            famKey: "SH",  kind: "grid" },
  ]},
  { name: "TCL", types: [
    { label: "Hi-Wall (SaveIN AI)",                 famKey: "TCL-HW", kind: "t1t3" },
  ]},
  { name: "SKM", types: [
    { label: "Hi-Wall (MSKMP-CVK1C60)",             famKey: "SKM-HW",  kind: "t1t3" },
    { label: "Ducted (Sierra DDP+RX)",              famKey: "SKM-DCT", kind: "t1t3" },
  ]},
];

// Resolve type keyword within a brand to { famKey, kind }
function resolveSplitType(brand, typeStr) {
  const t = typeStr.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = SPLIT_BRANDS.find(b => b.name.toLowerCase() === brand.toLowerCase());
  if (!b) return null;
  if (brand === "TCL") return b.types[0];
  const isDuctedInv = /sh|inverterd|dinv|ductedinv/.test(t) || (/duct/.test(t) && /inv/.test(t));
  const isDucted    = /duct|bsp|asp|ddp/.test(t);
  if (isDuctedInv) return b.types.find(x => /SH/.test(x.famKey)) ?? null;
  if (isDucted)    return b.types.find(x => /BSP|DCT/.test(x.famKey)) ?? null;
  // hi-wall / wall / pkv or default
  return b.types.find(x => /PKV|HW/.test(x.famKey)) ?? b.types[0];
}


// 1 ton refrigeration = 3.51685 kW (matches products.js / vrfIntake.js).
const SPLIT_TR_KW = 3.51685;

// Parse the rating-condition reply in the guided flow. Accepts T1/T3, bare
// 1/3, or the ambient (35/46). Returns "T1", "T3", or null.
function parseSplitCondition(text) {
  const t = (text || "").trim().toLowerCase();
  if (/^t?\s*1$/.test(t) || /\bt1\b/.test(t) || /\b35\b/.test(t)) return "T1";
  if (/^t?\s*3$/.test(t) || /\bt3\b/.test(t) || /\b46\b/.test(t)) return "T3";
  return null;
}

// Parse one capacity line in the guided flow: a capacity, with an OPTIONAL
// type and an OPTIONAL on-coil "DB/WB" (Toshiba only — the grid families
// interpolate on indoor DB). Capacity may be kW (default) or tonnage
// ("ton"/"TR"/trailing "t"). Type defaults to Hi-Wall; "ducted"/"D"/"duc"
// selects ducted. On-coil is null when not given (→ caller uses standard
// T1/T3 on-coil).
//   "5", "5 kw", "1.5 ton", "8 kw ducted", "2 ton d", "5 hw",
//   "5 kw 24/17", "8 kw ducted 26.7/19.4"
// Returns { loadKw, typeStr, idb, iwb } or null.
function parseSplitCapacityLine(line) {
  const raw = (line || "").trim().toLowerCase();

  // Pull out an on-coil DB/WB token first ("num/num") so its numbers aren't
  // mistaken for the capacity; strip it before reading the rest.
  let idb = null, iwb = null;
  const onCoil = raw.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  let rest = raw;
  if (onCoil) {
    idb = parseFloat(onCoil[1]);
    iwb = parseFloat(onCoil[2]);
    rest = raw.replace(onCoil[0], " ");
  }

  const numMatch = rest.match(/[\d.]+/);
  if (!numMatch) return null;
  const val = parseFloat(numMatch[0]);
  if (!val || val <= 0) return null;

  // Tonnage if "ton"/"tons"/"tonnage"/"tr" appears, or a number with trailing "t".
  const isTon = /\bton(s|nage)?\b|\btr\b/.test(rest) || /[\d.]+\s*t\b/.test(rest);
  const loadKw = isTon ? Math.round(val * SPLIT_TR_KW * 100) / 100 : val;

  // Type: ducted aliases first (D / duc / duct / ducted), else default Hi-Wall.
  let typeStr = "hi wall";
  if (/\bduct(ed)?\b|\bduc\b|(?:^|\s)d(?:\s|$)/.test(rest)) typeStr = "ducted";

  return { loadKw, typeStr, idb, iwb };
}

// Rank with auto-split: if load > biggest model, try dividing by 2,3,4
// Returns { ranked, count, splitNote }
function rankSplitWithCount(famKey, loadKw, idb, iwb, odb, condition) {
  for (let n = 1; n <= 4; n++) {
    const ranked = rankSplit(famKey, loadKw / n, idb, iwb, odb, condition);
    if (ranked.length && ranked[0].adequate) {
      const note = n > 1
        ? `Load ${loadKw} kW exceeds single unit capacity — split into ${n} units of ${(loadKw/n).toFixed(2)} kW each`
        : null;
      return { ranked, count: n, splitNote: note };
    }
  }
  // No adequate found even at /4 — return single-unit closest
  const ranked = rankSplit(famKey, loadKw, idb, iwb, odb, condition);
  return { ranked, count: 1, splitNote: null };
}

// Format one unit result as WhatsApp text
function formatSplitUnit(unitNum, res) {
  const { ranked, count, loadKw, condStr, famLabel, splitNote } = res;
  const f2 = v => v != null ? Number(v).toFixed(2) : "—";
  const best = ranked[0];
  if (!best) return `*Unit ${unitNum}* ❌ No data`;
  const ok        = best.adequate;
  const margin    = best.margin != null ? ` (+${(best.margin * 100).toFixed(0)}%)` : "";
  const shc       = best.shc != null ? ` · SC ${f2(best.shc)} kW` : "";
  const countTag  = count > 1 ? `${count}× ` : "";
  const statusIcon = ok ? "✅" : "⚠️";

  let out = `*${statusIcon} Unit ${unitNum}* — ${famLabel}\n`;
  out += `Load ${loadKw} kW · ${condStr}\n`;
  out += `→ ⭐ *${countTag}${best.key}*\n`;
  out += `TC ${f2(best.tc)} kW${margin}${shc} · Power ${f2(best.p)} kW · EER ${f2(best.eer)}`;
  if (count > 1) out += `\n   Combined: TC ${f2(best.tc * count)} kW · Power ${f2(best.p * count)} kW`;
  if (splitNote) out += `\n   ℹ️ ${splitNote}`;
  if (res.typeNote) out += `\n   ℹ️ ${res.typeNote}`;
  if (!ok) out += `\n⚠️ Still undersized — contact supplier`;
  return out;
}

async function handleSplitStep(from, s, text) {
  // ── Step 1/3: choose brand ──────────────────────────────────
  if (s.step === "brand") {
    const t = text.trim();
    let brand = null;
    if (/^1$|toshiba/i.test(t))  brand = "Toshiba";
    else if (/^2$|tcl/i.test(t)) brand = "TCL";
    else if (/^3$|skm/i.test(t)) brand = "SKM";
    if (!brand) {
      return sendText(from,
        "❌ Reply *1*, *2*, or *3*:\n1. Toshiba\n2. TCL\n3. SKM\n\nType *cancel* to exit."
      );
    }
    s.brand = brand;
    s.step  = "condition";

    return sendText(from,
      `✅ *${brand}*\n\n` +
      "*Step 2/3:* Rating condition?\n" +
      "• *T1* — 35°C ambient\n" +
      "• *T3* — 46°C ambient\n\n" +
      "Reply *T1* or *T3*."
    );
  }

  // ── Step 2/3: rating condition (T1 / T3) ────────────────────
  if (s.step === "condition") {
    const cond = parseSplitCondition(text);
    if (!cond) {
      return sendText(from, "❌ Reply *T1* (35°C) or *T3* (46°C).\nType *cancel* to exit.");
    }
    s.condition = cond;
    if (cond === "T1") { s.idb = 27; s.iwb = 19; s.odb = 35; }
    else               { s.idb = 29; s.iwb = 19; s.odb = 46; }
    s.step = "capacities";

    const b = SPLIT_BRANDS.find(b => b.name === s.brand);
    const hasDucted = b.types.some(x => /BSP|DCT|SH/.test(x.famKey));
    const hasGrid   = b.types.some(x => x.kind === "grid"); // Toshiba only

    const coilHint = hasGrid
      ? "\n\n*On-coil (optional, Toshiba):* add `DB/WB` to a line —\n" +
        "• `5 kw 24/17`  → on-coil 24/17°C\n" +
        `Omit it to use the standard *${cond}* on-coil (${s.idb}/${s.iwb}°C).`
      : "";

    return sendText(from,
      `✅ *${s.brand} · ${cond}* (${s.odb}°C ambient)\n\n` +
      "*Step 3/3:* Enter capacities — one per line.\n" +
      "kW or tonnage; unit type optional:\n" +
      "• `5`  or  `5 kw`  → Hi-Wall\n" +
      "• `1.5 ton`  → Hi-Wall\n" +
      (hasDucted ? "• `8 kw ducted`  or  `2 ton d`  → Ducted\n" : "") +
      "\n" +
      (hasDucted
        ? "Default type is *Hi-Wall* if you don't specify one."
        : `${s.brand} splits are *Hi-Wall* only.`) +
      "\n\n_Aliases — Hi-Wall: HW · WM · Wall · Split   |   Ducted: D · Duc_" +
      coilHint
    );
  }

  // ── Step 3/3: capacities list → rank all → output + store for Print ─
  if (s.step === "capacities") {
    const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) {
      return sendText(from, "❌ No capacities found. Enter at least one line.\nType *cancel* to exit.");
    }

    const unitResults = [];
    const errors      = [];

    lines.forEach((line, i) => {
      const parsed = parseSplitCapacityLine(line);
      if (!parsed) {
        errors.push(`Line ${i + 1}: couldn't read a capacity — "${line}"`);
        unitResults.push({ lineNum: i + 1, error: `Couldn't read: "${line}"` });
        return;
      }
      const resolved = resolveSplitType(s.brand, parsed.typeStr);
      if (!resolved) {
        errors.push(`Line ${i + 1}: no "${parsed.typeStr}" type for ${s.brand}`);
        unitResults.push({ lineNum: i + 1, error: `No ${parsed.typeStr} for ${s.brand}` });
        return;
      }
      // If a ducted unit was asked but the brand has none, resolveSplitType
      // falls back to Hi-Wall — surface that so the result isn't surprising.
      const askedDucted = parsed.typeStr === "ducted";
      const gotDucted   = /BSP|DCT|SH/.test(resolved.famKey);
      let note = askedDucted && !gotDucted
        ? `${s.brand} has no ducted split — used Hi-Wall instead`
        : null;

      // On-coil DB/WB only affects the grid (Toshiba) families. Use the
      // line's on-coil if given; otherwise the standard T1/T3 on-coil. For
      // non-grid (TCL/SKM, fixed-point) ratings, a supplied on-coil is ignored.
      const isGrid = resolved.kind === "grid";
      const customCoil = isGrid && parsed.idb != null;
      const useIdb = customCoil ? parsed.idb : s.idb;
      const useIwb = customCoil ? (parsed.iwb ?? s.iwb) : s.iwb;
      if (parsed.idb != null && !isGrid) {
        const n2 = `on-coil ignored — ${s.brand} uses fixed ${s.condition} ratings`;
        note = note ? `${note}; ${n2}` : n2;
      }

      const { ranked, count, splitNote } = rankSplitWithCount(
        resolved.famKey, parsed.loadKw, useIdb, useIwb, s.odb, s.condition
      );
      const famLabel = SPLIT_BRANDS.find(b => b.name === s.brand)
        ?.types.find(t => t.famKey === resolved.famKey)
        ?.label?.split("(")[0]?.trim() ?? resolved.famKey;
      const condStr = customCoil
        ? `${s.condition} · on-coil ${useIdb}/${useIwb}°C @ ${s.odb}°C`
        : `${s.condition} (${s.odb}°C)`;
      const best = ranked[0];

      unitResults.push({
        lineNum:  i + 1,
        loadKw:   parsed.loadKw,
        typeStr:  parsed.typeStr,
        famLabel, condStr,
        idb: useIdb, iwb: useIwb, odb: s.odb,
        condition: s.condition,
        famKey:   resolved.famKey,
        kind:     resolved.kind,
        count,    splitNote,
        ranked,
        model:    best?.key ?? "—",
        tc:       best?.tc,
        shc:      best?.shc ?? null,
        p:        best?.p,
        eer:      best?.eer,
        margin:   best?.margin,
        adequate: best?.adequate ?? false,
        typeNote: note,
      });
    });

    store.endFlow(from);

    // Store results for PDF print (30 min TTL)
    const goodUnits = unitResults.filter(u => !u.error);
    store.setCtx(from, "splitResult", { brand: s.brand, units: unitResults }, 30 * 60 * 1000);

    // Build WhatsApp text output
    const textBlocks = unitResults.map((u) =>
      u.error
        ? `*❌ Unit ${u.lineNum}* — ${u.error}`
        : formatSplitUnit(u.lineNum, u)
    );

    const header = `🧊 *Split Selection — ${s.brand} · ${s.condition}*  (${goodUnits.length} unit${goodUnits.length !== 1 ? "s" : ""})\n`;
    const body   = textBlocks.join("\n\n─────────────────\n\n");
    const errStr = errors.length ? "\n\n⚠️ *Skipped:* " + errors.join(" | ") : "";

    await sendText(from,
      header + "\n" + body + errStr + "\n\n" +
      "_Verify against manufacturer selection software before submittal._\n\n" +
      "Reply *Print* for a PDF report · *Split Selection* to run again."
    );
  }
}

async function handleScheduleStep(from, s, message, vText) {
  // 1) Waiting for the image/PDF.
  if (s.step === "awaitImage") {
    let media = null;
    if (message.type === "image" && message.image?.id) media = message.image.id;
    else if (message.type === "document" && message.document?.id) media = message.document.id;
    if (!media) return await sendText(from, "Please send the schedule as an *image* or *PDF*.");

    s.step = "processing"; // guard against a second image launching a duplicate extraction
    let dl;
    try { dl = await downloadWhatsAppMedia(media); }
    catch (err) {
      console.error("❌ Schedule media download error:", err.response?.data || err.message);
      s.step = "awaitImage";
      return await sendText(from, "I couldn't download that file. Try again, or send a clearer photo.");
    }
    const mediaType = message.type === "document"
      ? (message.document.mime_type || dl.mediaType) : dl.mediaType;

    await sendText(from, "🔍 Reading the schedule, one moment…");
    let extracted;
    try { extracted = await schedule.rowsFromScheduleImage(dl.buffer.toString("base64"), mediaType); }
    catch (err) {
      console.error("❌ Schedule extraction error:", err.message);
      s.step = "awaitImage";
      return await sendText(from, "Sorry, I couldn't read that schedule. Try a clearer image or a PDF.");
    }
    if (!extracted.rows.length) {
      s.step = "awaitImage";
      return await sendText(from, "I didn't find any schedule rows. Please resend a clearer image, or type *cancel* to exit.");
    }
    s.rows = extracted.rows;
    s.skipped = extracted.skipped;
    if (extracted.scheduleCondition) {
      s.cond = extracted.scheduleCondition;
      const label = s.cond === "T1" ? "T1 (35°C)" : "T3 (46°C)";
      await sendText(from,
        `I read *${extracted.rows.length}* rows. Detected rating *${label}* from the schedule.`);
      return await advanceScheduleQuestions(from, s);
    }
    s.step = "awaitCondition";
    return await sendText(from,
      `I read *${extracted.rows.length}* rows.\n\n*Rate capacities at?*\n1. T1 (35°C)\n2. T3 (46°C)`);
  }

  // While an extraction is in flight, a second file just gets a wait notice.
  if (s.step === "processing") {
    return await sendText(from, "⏳ Still reading the previous file — one moment…");
  }

  // 2) Rating condition.
  if (s.step === "awaitCondition") {
    if (vText === "1") s.cond = "T1";
    else if (vText === "2") s.cond = "T3";
    else return await sendText(from, "Reply *1* for T1 (35°C) or *2* for T3 (46°C).");
    return await advanceScheduleQuestions(from, s);
  }

  // 3) Split brand.
  if (s.step === "awaitSplitBrand") {
    const map = { "1": "toshiba", "2": "tcl", "3": "skm" };
    if (!map[vText]) return await sendText(from, "Reply *1* Toshiba, *2* TCL, or *3* SKM.");
    s.splitBrand = map[vText];
    return await advanceScheduleQuestions(from, s);
  }

  // 4) Package vendor.
  if (s.step === "awaitPkgVendor") {
    if (vText === "1") { s.pkgVendor = "skm"; s.step = "awaitPkgSeries";
      return await sendText(from, "*APMR or APMR-A?*\n1. APMR\n2. APMR-A"); }
    if (vText === "2") { s.pkgVendor = "trane"; s.pkgSeries = null;
      return await advanceScheduleQuestions(from, s); }
    return await sendText(from, "Reply *1* SKM or *2* Trane.");
  }

  // 5) Package SKM series.
  if (s.step === "awaitPkgSeries") {
    if (vText === "1") s.pkgSeries = "apmr";
    else if (vText === "2") s.pkgSeries = "apmr-a";
    else return await sendText(from, "Reply *1* APMR or *2* APMR-A.");
    return await advanceScheduleQuestions(from, s);
  }
}

// Ask the next needed question, or produce the result when all answered.
async function advanceScheduleQuestions(from, s) {
  const sum = schedule.summarize(s.rows);
  if (sum.hasSplit && !s.splitBrand) {
    s.step = "awaitSplitBrand";
    return await sendText(from, "*Which split brand?*\n1. Toshiba\n2. TCL\n3. SKM");
  }
  if (sum.hasPackage && !s.pkgVendor) {
    s.step = "awaitPkgVendor";
    return await sendText(from, "*Package line?*\n1. SKM (APMR)\n2. Trane (MTZ)");
  }
  const reply = schedule.buildReply(s.rows, s.skipped, {
    cond: s.cond, splitBrand: s.splitBrand, pkgVendor: s.pkgVendor, pkgSeries: s.pkgSeries,
  });

  // Store results for PDF print (30 min TTL)
  store.setCtx(from, "scheduleResult", {
    cond: s.cond, splitBrand: s.splitBrand, pkgVendor: s.pkgVendor, pkgSeries: s.pkgSeries,
    rows: s.rows, skipped: s.skipped,
  }, 30 * 60 * 1000);

  store.endFlow(from);
  return await sendLongText(from, reply + "\n\nReply *Print* or *Datasheet* for a PDF report + package datasheets · *Schedule Selection* to run again.");
}

// Send split PDF report when user replies "Print"
async function handleSplitPrint(from) {
  const stored = store.getCtx(from, "splitResult");
  if (!stored) {
    return sendText(from, "❌ No recent split results found. Run *Split Selection* first.");
  }

  await sendText(from, "⏳ Generating PDF report…");

  let pdfBuffer;
  try {
    pdfBuffer = await generateSplitPdf({ brand: stored.brand, units: stored.units });
  } catch (err) {
    console.error("❌ Split PDF error:", err.message);
    return sendText(from, "❌ Failed to generate PDF. Please try again.");
  }

  try {
    await sendPdfBuffer(
      from, pdfBuffer, `Split_Selection_${stored.brand}.pdf`,
      `${stored.brand} Split Unit Selection — ${stored.units.filter(u => !u.error).length} units`
    );
  } catch (err) {
    console.error("❌ Split PDF send error:", err.message);
    return sendText(from, "❌ PDF generated but could not be sent. Please try again.");
  }
}

// Send schedule/BOQ PDF report when user replies "Print"
async function handleSchedulePrint(from) {
  const stored = store.getCtx(from, "scheduleResult");
  if (!stored) {
    return sendText(from, "❌ No recent schedule results found. Run *Schedule Selection* first.");
  }

  await sendText(from, "⏳ Generating PDF report…");

  let pdfBuffer;
  try {
    pdfBuffer = await generateSchedulePdf({
      cond: stored.cond, splitBrand: stored.splitBrand,
      pkgVendor: stored.pkgVendor, pkgSeries: stored.pkgSeries,
      rows: stored.rows, skipped: stored.skipped,
    });
  } catch (err) {
    console.error("❌ Schedule PDF error:", err.message);
    return sendText(from, "❌ Failed to generate PDF. Please try again.");
  }

  try {
    await sendPdfBuffer(
      from, pdfBuffer, "Schedule_Selection.pdf",
      `Schedule / BOQ Selection — ${stored.rows.length} rows`
    );
  } catch (err) {
    console.error("❌ Schedule PDF send error:", err.message);
    return sendText(from, "❌ PDF generated but could not be sent. Please try again.");
  }

  // ── Package datasheets: SKM fetched from Drive, Trane MTZ regenerated
  // fresh from the same inputs that picked the model in the report above.
  // Split/ducted rows need nothing extra — the report's Required/Proposed
  // columns already cover them.
  const { pkgResults } = schedule.computeSelections(stored.rows, {
    cond: stored.cond, splitBrand: stored.splitBrand,
    pkgVendor: stored.pkgVendor, pkgSeries: stored.pkgSeries,
  });
  if (!pkgResults.length) return;

  await sendText(from, "⏳ Sending package datasheets…");

  // Fetch the Drive file index once up front (not per row) so a single
  // Drive failure surfaces one clear diagnostic instead of N identical ones.
  let driveFiles = null;
  let driveError = null;
  if (pkgResults.some((p) => p.vendor === "skm")) {
    try {
      driveFiles = await listFolderFiles();
      console.log(`📄 SKM datasheet lookup: Drive index has ${driveFiles.length} file(s)`);
    } catch (err) {
      driveError = err;
      console.error("❌ SKM datasheet Drive fetch error:", err.response?.data || err.stack || err.message);
    }
  }

  for (const { row: r, vendor, match: m } of pkgResults) {
    if (vendor === "skm") {
      const seriesKey = m.series === "apmr-a" ? "APMR-A" : "APMR";
      if (driveError) {
        await sendText(from,
          `❌ Could not reach Drive for the ${seriesKey} ${m.code} datasheet (${driveError.message}). Please try again.`
        );
        continue;
      }
      try {
        const matches = findDatasheetFiles(seriesKey, m.code, driveFiles);
        const exact = matches.find((f) => f.condition === stored.cond);
        const file = exact || matches[0];
        console.log(
          `📄 SKM datasheet lookup: ${seriesKey} ${m.code} @ ${stored.cond} -> ` +
          `${matches.length} match(es)${file ? `, sending "${file.name}"` : ", none found"}`
        );
        if (file) {
          await sendDriveFile(from, file);
        } else {
          await sendText(from,
            `Apologies — the ${seriesKey} ${m.code} datasheet isn't available yet; kindly email hassan.saleem@mannai.com.qa to get the required document.`
          );
        }
      } catch (err) {
        console.error("❌ SKM datasheet error:", err.response?.data || err.stack || err.message);
        await sendText(from, `❌ Could not fetch the ${seriesKey} ${m.code} datasheet for ${r.location} (${err.message}). Please try again.`);
      }
    } else if (vendor === "trane") {
      try {
        const mtzBuffer = await generateMtzPdf({
          reqTC: m.reqTC, reqSC: 0, db: m.db, wb: m.wb, amb: m.amb,
          airflow: r.airflow || null, tag: r.location,
        });
        if (mtzBuffer) {
          await sendPdfBuffer(
            from, mtzBuffer, `MTZ_Selection_${r.location}.pdf`,
            `Trane MTZ ${m.key} — ${r.location}`
          );
        }
      } catch (err) {
        console.error("❌ MTZ datasheet error:", err.message);
        await sendText(from, `❌ Could not generate the MTZ datasheet for ${r.location}.`);
      }
    }
  }
}

// ============================================================
//  TRANE MTZ STEP HANDLER
// ============================================================
const TR_TO_MBH = 12; // 1 TR = 12 MBtu/h
const { rankModels: mtzRank } = require("./mtz-engine.js");

// Parse a cooling load like "8.5 TR", "100", "100 MBH"
function parseMbh(text) {
  const t = text.toLowerCase().trim();
  const trMatch = t.match(/^([\d.]+)\s*(?:tr|ton|tons)\b/);
  if (trMatch) return parseFloat(trMatch[1]) * TR_TO_MBH;
  const numMatch = t.match(/^([\d.]+)\s*(?:mbh|mbtu\/h|mbtuh)?\b/);
  if (numMatch) return parseFloat(numMatch[1]);
  return null;
}

// Parse "8.5TR / 7TR sc" → { tc: 102, sc: 84 }  or just "8.5 TR" → { tc: 102, sc: null }
function parseLoad(text) {
  const parts = text.split(/[,\/|]+/);
  const tc = parseMbh(parts[0]);
  if (!tc) return null;
  let sc = null;
  if (parts[1]) {
    const v = parseMbh(parts[1]);
    if (v && v < tc) sc = v;
  }
  return { tc, sc };
}

// Parse "80/67/115" or "80 67 115" → { db, wb, amb }
function parseConditions(text) {
  const nums = text.match(/[\d.]+/g);
  if (!nums || nums.length < 3) return null;
  return { db: parseFloat(nums[0]), wb: parseFloat(nums[1]), amb: parseFloat(nums[2]) };
}

// Parse "2800 | Project Name | TAG-01" or "rated | Project Name"
function parseExtras(text) {
  const parts = text.split(/\|/).map(p => p.trim());
  const afRaw = parts[0];
  const useRated = /^(rated|skip|auto)$/i.test(afRaw);
  const cfm = useRated ? null : parseFloat(afRaw.match(/[\d.]+/)?.[0] ?? "");
  if (!useRated && (!cfm || cfm < 500 || cfm > 20000)) return null;
  return {
    airflow: useRated ? null : cfm,
    project: parts[1] || "",
    tag:     parts[2] || "",
  };
}

// Build a ranked text summary of top models
function mtzRankSummary(reqTC, reqSC, db, wb, amb) {
  const ranked = mtzRank(reqTC, reqSC || 0, db, wb, amb);
  const adequate = ranked.filter(r => r.adequate);
  const show = (adequate.length ? adequate : ranked).slice(0, 3);
  const fmt1 = v => v.toFixed(1);
  const lines = show.map((r, i) => {
    const eer = r.r.PI > 0 ? (r.r.TC * 1000 / r.r.PI).toFixed(2) : "—";
    const margin = r.tcMargin != null ? ` (+${(r.tcMargin * 100).toFixed(0)}%)` : "";
    const label = i === 0 ? "⭐ " : `${i + 1}. `;
    return `${label}*${r.key}* — TC ${fmt1(r.r.TC)} MBH (${fmt1(r.r.TC/TR_TO_MBH)} TR)${margin}\n` +
           `   SC ${fmt1(r.r.SC)} MBH · ${fmt1(r.r.PI)} kW · EER ${eer}\n` +
           `   Off-coil DB ${fmt1(r.oc.dbOff)}°F / WB ${fmt1(r.oc.wbOff)}°F`;
  });
  return lines.join("\n\n");
}

async function handleMtzStep(from, s, text) {
  // ── Step 1: cooling load ────────────────────────────────────
  if (s.step === "load") {
    const load = parseLoad(text);
    if (!load || load.tc <= 0) {
      return sendText(from,
        "❌ Couldn't read that load. Try:\n" +
        "• `8.5 TR`  or  `100 MBH`\n" +
        "• With sensible: `8.5TR / 7TR`\n" +
        "Type *cancel* to exit."
      );
    }
    s.reqTC = load.tc;
    s.reqSC = load.sc;
    s.step  = "conditions";
    const scNote = load.sc ? ` · sensible ${load.sc.toFixed(1)} MBH (${(load.sc/TR_TO_MBH).toFixed(2)} TR)` : "";
    return sendText(from,
      `✅ Load: *${load.tc.toFixed(1)} MBH (${(load.tc/TR_TO_MBH).toFixed(2)} TR)*${scNote}\n\n` +
      "*Step 2/3:* Enter on-coil *DB / WB* and *outdoor ambient* on one line:\n" +
      "e.g. `80/67/115`  _(DB°F / WB°F / Amb°F)_\n" +
      "_(Typical Gulf: 80/67/115)_"
    );
  }

  // ── Step 2: DB / WB / Ambient (combined) ───────────────────
  if (s.step === "conditions") {
    const c = parseConditions(text);
    if (!c || c.db < 60 || c.db > 100 || c.wb < 50 || c.wb > 85 || c.wb > c.db || c.amb < 70 || c.amb > 135) {
      return sendText(from,
        "❌ Couldn't parse. Enter three numbers: DB / WB / Ambient in °F\n" +
        "e.g. `80/67/115`\n" +
        "DB: 60–100 · WB: 50–85 · Amb: 70–135 · WB ≤ DB\n" +
        "Type *cancel* to exit."
      );
    }
    s.db   = c.db;
    s.wb   = c.wb;
    s.amb  = c.amb;
    s.step = "extras";
    return sendText(from,
      `✅ Conditions: *DB ${c.db}°F / WB ${c.wb}°F · Ambient ${c.amb}°F*\n\n` +
      "*Step 3/3:* Enter supply *airflow* (CFM), or *rated* for catalogue default.\n" +
      "Optionally add project name & unit tag separated by `|`:\n" +
      "• `rated`\n" +
      "• `2800`\n" +
      "• `2800 | MOEHE School | PAC-01`\n" +
      "• `rated | Cooling Tower Project | CU-03`"
    );
  }

  // ── Step 3: airflow + optional project/tag → generate PDF ──
  if (s.step === "extras") {
    const ex = parseExtras(text);
    if (!ex) {
      return sendText(from,
        "❌ Enter airflow CFM (500–20000), or *rated*.\n" +
        "Examples: `2800`  |  `rated`  |  `2800 | Project | TAG`\n" +
        "Type *cancel* to exit."
      );
    }
    s.airflow = ex.airflow;
    s.project = ex.project;
    s.tag     = ex.tag;
    store.endFlow(from);

    // Show ranked text preview first
    let previewText = "";
    try {
      previewText = mtzRankSummary(s.reqTC, s.reqSC, s.db, s.wb, s.amb);
    } catch (_) { /* skip preview on error */ }

    const cfmLabel = ex.airflow ? `${ex.airflow} CFM` : "rated (catalogue)";
    await sendText(from,
      `✅ Airflow: *${cfmLabel}*\n\n` +
      (previewText ? `*📊 Top Models @ DB${s.db}/WB${s.wb}°F, ${s.amb}°F amb:*\n\n${previewText}\n\n` : "") +
      "⏳ Generating full datasheet PDF…"
    );

    console.log(`📊 MTZ selection: reqTC=${s.reqTC} reqSC=${s.reqSC} DB=${s.db} WB=${s.wb} amb=${s.amb} airflow=${s.airflow}`);

    let pdfBuffer;
    try {
      pdfBuffer = await generateMtzPdf({
        reqTC:   s.reqTC,
        reqSC:   s.reqSC || 0,
        db:      s.db,
        wb:      s.wb,
        amb:     s.amb,
        airflow: s.airflow,
        project: s.project,
        tag:     s.tag,
      });
    } catch (err) {
      console.error("❌ MTZ PDF error:", err.message);
      return sendText(from, "❌ Failed to generate the datasheet. Please try again or contact support.");
    }

    if (!pdfBuffer) {
      return sendText(from, "❌ No MTZ model found for those conditions. Please try different values.");
    }

    try {
      const projLabel = s.project ? ` · ${s.project}${s.tag ? " / " + s.tag : ""}` : "";
      await sendPdfBuffer(
        from, pdfBuffer, `MTZ_Selection${s.tag ? "_" + s.tag : ""}.pdf`,
        `Trane MTZ — ${(s.reqTC / TR_TO_MBH).toFixed(1)} TR @ DB${s.db}/WB${s.wb}°F, ${s.amb}°F amb${projLabel}`
      );
    } catch (err) {
      console.error("❌ MTZ send error:", err.message);
      return sendText(from, "❌ PDF was generated but could not be sent. Please try again.");
    }
  }
}

// ============================================================
//  WEBHOOK RECEIVER
// ============================================================
async function handleIncomingMessage(value, message) {
    const from = message.from;

    // Blue-tick + "typing…" right away; clears when our reply sends.
    markReadWithTyping(message.id); // fire-and-forget by design

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

      // Menu row tap -> that section's tip card.
      if (btnId.startsWith("menu|")) {
        const n = parseInt(btnId.split("|")[1], 10);
        const tip = tipFor(n);
        if (tip) return await sendText(from, tip);
        return; // stale/unknown row
      }

      // Chiller buttons (chmodel|, chsel|, chds|) -> series pick / spec / datasheet.
      const chillerBtn = handleChillerButton(btnId);
      if (chillerBtn) return await sendChillerResponse(from, chillerBtn);

      // Unit toggle (units|si / units|imp) -> re-render the last list in the
      // chosen system. State remembers which list it was.
      if (btnId.startsWith("units|")) {
        const system = btnId.split("|")[1] === "imp" ? "imp" : "si";
        const st = store.getCtx(from, "unitList");
        if (!st) {
          return await sendText(from,
            "That list has expired — just ask for it again (e.g. *list of split units* or *APMR list*).");
        }
        return await sendListWithToggle(from, st.kind, st.keys, system);
      }

      const action = handleButtonTap(btnId);
      if (action?.type === "interactive") {
        return await sendButtons(from, action.text, action.buttons);
      }
      // Catalogue / IOM choice -> fetch from that folder ONLY
      if (action?.type === "folderFile") {
        const file = await resolveSeriesFile(action.series, action.docType, listFolderFiles);
        if (file) return await sendDriveFile(from, file);
        return await sendNotFoundWithSuggestions(from, `${action.series} ${action.docType}`);
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
        return await sendNotFoundWithSuggestions(from, action.fileName, files);
      }
      // Doc-type choice button: "doctype|IOM|<query>" or "doctype|Catalogue|<query>"
      if (btnId.startsWith("doctype|")) {
        const [, docType, ...queryParts] = btnId.split("|");
        const query = queryParts.join("|");
        const files = await listFolderFiles();
        const filtered = files.filter((f) => fileMatchesDocType(f, docType));
        const aiHits = await aiMatchFile(query, filtered);
        if (aiHits && aiHits.length >= 1) return await sendFileOptions(from, aiHits, `${docType} — which product?`);
        return await sendNotFoundWithSuggestions(from, query, files);
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
        return await sendNotFoundWithSuggestions(from, model, files);
      }

      // Direct file by Drive ID (used by sendFileOptions buttons)
      if (btnId.startsWith("fileid|")) {
        const fileId = btnId.slice(7);
        const files = await listFolderFiles();
        const file = files.find((f) => f.id === fileId);
        if (file) return await sendDriveFile(from, file);
        return await sendText(from, NOT_FOUND_MSG);
      }

      return; // unknown button
    }

    // ── Global escape: a bare greeting / "menu" / "help" ALWAYS shows the menu
    // and clears any in-flight session, so a stuck or half-finished flow can
    // never trap the user with no reply. Runs BEFORE every session check.
    // isMenuTrigger only matches whole-message greetings/menu words, so it never
    // hijacks a real request like "hi can I get the APMR catalogue".
    if (message.type === "text" && isMenuTrigger(message.text.body)) {
      vrfSessions.delete(from);
      store.clearAll(from);
      console.log(`📋 welcome menu (global escape) -> ${from}`);
      const m = welcomeMenuList(profileName, crm.isKnownContact(from));
      store.setCtx(from, "menu", { options: m.options }, 15 * 60 * 1000); // numbered replies still work
      return await sendList(from, m.body, m.buttonLabel, m.rows);
    }

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

    // ── Schedule / BOQ image selection ───────────────────────────
    // Trigger: exact "Image Selection" / "BOQ Selection" / "Schedule Selection".
    if (message.type === "text" &&
        /^(image|boq|schedule)\s+selection$/i.test(message.text.body.trim())) {
      store.startFlow(from, "schedule", { step: "awaitImage" });
      return await sendText(from,
        "📋 *Schedule / BOQ Selection*\n\nSend the equipment schedule as an *image* or *PDF*.\n_(Type *cancel* anytime to exit)_");
    }

    // ── Active guided flow (split / mtz / schedule) ─────────────
    const flow = store.getFlow(from);
    if (flow?.expired) {
      const names = { split: "Split Selection", mtz: "MTZ Selection", schedule: "Schedule Selection" };
      return await sendText(from, `⏰ ${names[flow.type] || "Your"} session timed out. Type *${names[flow.type] || "menu"}* to start again.`);
    }
    if (flow) store.touchFlow(from);

    if (flow?.type === "schedule") {
      const vText = message.type === "text" ? message.text.body.trim() : "";
      return await handleScheduleStep(from, flow.data, message, vText);
    }

    if (message.type !== "text") return;
    const text = message.text.body.trim();

    // Numeric reply to a pending numbered list ("1", "2", etc.)
    const pendingList = store.getCtx(from, "list");
    if (/^\d+$/.test(text) && pendingList) {
      const idx = parseInt(text, 10) - 1;
      store.clearCtx(from, "list");
      if (idx >= 0 && idx < pendingList.length) {
        console.log(`🔢 ${from} selected #${idx + 1}: ${pendingList[idx].name}`);
        return await sendDriveFile(from, pendingList[idx]);
      }
      return await sendText(from, `Please reply with a number between 1 and ${pendingList.length}.`);
    }

    // ── Split / Schedule PDF print request ───────────────────────
    if (/^print$/i.test(text.trim()) && store.getCtx(from, "splitResult")) {
      return await handleSplitPrint(from);
    }
    if (/^(print|datasheet)$/i.test(text.trim()) && store.getCtx(from, "scheduleResult")) {
      return await handleSchedulePrint(from);
    }

    // ── Split unit multi-step session ──────────────────────────
    if (flow?.type === "split") {
      return await handleSplitStep(from, flow.data, text);
    }
    // Trigger: exact phrase "Split Selection"
    if (/^split\s+selection$/i.test(text.trim())) {
      store.startFlow(from, "split", { step: "brand" });
      return await sendText(from,
        "🧊 *Split Unit Selector*\n\n" +
        "*Step 1/3:* Choose brand:\n" +
        "1. Toshiba\n2. TCL\n3. SKM\n\n" +
        "_(Type *cancel* anytime to exit)_"
      );
    }

    // ── MTZ multi-step session ─────────────────────────────────
    if (flow?.type === "mtz") {
      return await handleMtzStep(from, flow.data, text);
    }
    // Trigger: exact phrase "MTZ Selection"
    if (/^mtz\s+selection$/i.test(text.trim())) {
      // Express mode: "MTZ Selection 8.5TR 80/67/115" — all params on one line
      const expressMatch = text.match(/^mtz\s+selection\s+(.+)/i);
      if (expressMatch) {
        const rest = expressMatch[1].trim();
        const loadPart = rest.split(/\s+/)[0];
        const load = parseLoad(loadPart);
        const nums = rest.match(/[\d.]+/g) || [];
        if (load && nums.length >= 4) {
          // nums[0]=load, nums[1]=DB, nums[2]=WB, nums[3]=Amb
          const db = parseFloat(nums[1]), wb = parseFloat(nums[2]), amb = parseFloat(nums[3]);
          if (db >= 60 && db <= 100 && wb >= 50 && wb <= 85 && wb <= db && amb >= 70 && amb <= 135) {
            store.startFlow(from, "mtz", {
              step: "extras",
              reqTC: load.tc, reqSC: load.sc,
              db, wb, amb,
            });
            const scNote = load.sc ? ` / SC ${load.sc.toFixed(1)} MBH` : "";
            return await sendText(from,
              `✅ *${load.tc.toFixed(1)} MBH${scNote} · DB${db}/WB${wb}°F · Amb ${amb}°F*\n\n` +
              "*Step 3/3:* Enter supply airflow CFM, or *rated*.\n" +
              "Optionally add project name & tag:\n" +
              "• `rated`  or  `2800`\n" +
              "• `2800 | Project Name | TAG-01`"
            );
          }
        }
      }
      store.startFlow(from, "mtz", { step: "load" });
      return await sendText(from,
        "🌡️ *Trane MTZ Package Unit Selector*\n\n" +
        "3 quick steps → ranked models + PDF datasheet.\n\n" +
        "*Step 1/3:* Required total cooling load?\n" +
        "• `8.5 TR`  or  `100 MBH`\n" +
        "• With sensible: `8.5 TR / 7 TR`\n\n" +
        "_(Type *cancel* anytime to exit)_"
      );
    }
    // ────────────────────────────────────────────────────────────

    const { rules, knowledge, allowed } = await loadSheet();

    if (allowed.length && !allowed.includes(from)) {
      console.log(`Ignored non-allowed: ${from}`);
      return;
    }

    console.log(`📩 ${from}: "${text}"`);

    // ── Welcome menu / help ──────────────────────────────────────
    // Numbered reply while a recent menu is open -> send that section's
    // "how to ask" tip card.
    const openMenu = store.getCtx(from, "menu");
    if (/^\d+$/.test(text) && openMenu) {
      const { options } = openMenu;
      const n = parseInt(text, 10);
      const tip = tipFor(n, options);
      if (tip) {
        console.log(`📋 ${from} menu pick ${n}`);
        return await sendText(from, tip);
      }
      return await sendText(from, `Please reply with a number between 1 and ${options.length}, or type *menu*.`);
    }

    // A bare number with no open menu/list would fall into document search and
    // return nonsense. Nudge instead.
    if (/^\d{1,2}$/.test(text)) {
      return await sendText(from, "That menu or list has expired. Type *menu* to see your options, or just tell me what you need — e.g. *APMR catalogue*.");
    }

    // Admin: "stats" -> usage summary from the CRM log. Restricted to
    // ADMIN_NUMBERS (comma-separated env var) when set; otherwise open
    // (internal tool). Falls through to normal routing for non-admins.
    if (/^stats$/i.test(text)) {
      const admins = (process.env.ADMIN_NUMBERS || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!admins.length || admins.includes(from)) {
        console.log(`📊 stats -> ${from}`);
        return await sendText(from, await crm.statsMessage());
      }
    }

    // Greeting / "menu" / "help" -> show the welcome menu (numbered list).
    if (isMenuTrigger(text)) {
      console.log(`📋 welcome menu -> ${from}`);
      store.clearCtx(from, "list");
      const m = welcomeMenuList(profileName, crm.isKnownContact(from));
      store.setCtx(from, "menu", { options: m.options }, 15 * 60 * 1000); // numbered replies still work
      return await sendList(from, m.body, m.buttonLabel, m.rows);
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
    // deterministic and free — no Claude call, so it works on the free plan.
    if (isSearchAllTrigger(text)) {
      const lastQuery = store.getCtx(from, "lastquery");
      if (!lastQuery) {
        return await sendText(from,
          "Tell me what to look for first — send the document name or a few words about it, " +
          "then reply *search all* if my suggestions miss.");
      }
      await announceSearch(`🔍 Searching every file for "${lastQuery}"…`);
      const hits = rankFiles(lastQuery, await listFolderFiles(), 10);
      console.log(`🗂️  search-all "${lastQuery}" -> ${hits.length} hit(s)`);
      if (!hits.length) {
        // Free scan exhausted. NOW offer the paid option — never before, so a
        // Claude call only happens once the free path has genuinely failed.
        return await sendText(from,
          `I searched every file name and folder in the Drive folder and found nothing close to "${lastQuery}".\n\n` +
          (aiAllowed()
            ? AI_SEARCH_HINT
            : "Try a word from the document's title, or email hassan.saleem@mannai.com.qa."));
      }
      return await sendFileOptions(from, hits,
        `Closest matches for "${lastQuery}" across all folders:`, false);
    }

    // ── "ai search": last resort, costs a Claude call ────────────
    // Only reachable after the free scan missed. Reads the whole index, not a
    // doc-type-filtered slice, so it can reach Submittal Files and the like.
    if (isAiSearchTrigger(text)) {
      const lastQuery = store.getCtx(from, "lastquery");
      if (!lastQuery) {
        return await sendText(from, "Tell me what to look for first, then reply *ai search*.");
      }
      if (!aiAllowed()) {
        console.log(`🔒 Free account tried ai search for "${lastQuery}"`);
        return await sendText(from, freePlanMessage(currentAccount()?.name));
      }
      await announceSearch(`🤖 Asking AI to look through every file for "${lastQuery}"…`);
      const files = await listFolderFiles();
      const hits = await aiRelatedFiles(lastQuery, files);
      console.log(`🤖 ai-search "${lastQuery}" -> ${hits.length} hit(s)`);
      if (!hits.length) {
        return await sendText(from,
          `Even AI couldn't find anything matching "${lastQuery}" in the Drive folder.\n\n` +
          "It may not be uploaded yet. Email hassan.saleem@mannai.com.qa and we'll get it to you.");
      }
      return await sendFileOptions(from, hits,
        `AI's closest matches for "${lastQuery}":`, false);
    }

    // Remember what they actually asked for, so a later "search all" knows
    // what to re-run. Set once here rather than in each lookup path, so every
    // route that can produce a wrong guess gets the escape hatch for free.
    store.setCtx(from, "lastquery", text, 30 * 60 * 1000);

    // ── List split units ─────────────────────────────────────────
    // "list of split units", "show toshiba splits", "list hi-wall splits" ->
    // every split model with total cooling at T1/T3 + EER. Checked before the
    // packaged-unit list and the AI gate so it never hits the API.
    const splitListReq = parseSplitListRequest(text);
    if (splitListReq) {
      console.log(`📋 split list: ${splitListReq.join(", ")}`);
      return await sendListWithToggle(from, "split", splitListReq, "si");
    }

    // ── List units in a series ───────────────────────────────────
    // "give me list of APMR units", "list all DMP models", "what chillers do
    // you have" -> every model in that series with capacity + airflow.
    const listReq = parseListRequest(text);
    if (listReq) {
      console.log(`📋 unit list: ${listReq.join(", ")}`);
      return await sendListWithToggle(from, "product", listReq, "imp");
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

    // ── Quick Questions about products ───────────────────────────
    // A spec-style question that is NOT asking for a document is answered by the
    // AI using PRODUCT_KB (real catalogue/datasheet numbers). Requests that name
    // a document (catalogue / IOM / datasheet) fall through to the file handlers.
    const mentionsDocument = /\b(datasheet|data ?sheet|catalog(?:ue)?|iom|manual|brochure|drawing|pdf|document|file)\b/i.test(text);
    const isSpecQuestion = !mentionsDocument && (
      /\?/.test(text) ||
      /\b(what|whats|what's|how many|how much|which|tell me|explain|compare|difference|capacity|cooling|airflow|eer|iplv|tonnage|weight|dimensions?|sound|dba|refrigerant)\b/i.test(text)
    );
    if (isSpecQuestion) {
      console.log(`❓ product question -> AI: "${text}"`);
      await announceSearch("🔍 Checking the specs…");
      const aiReply = await askClaude(text, knowledge);
      if (aiReply && !/connect you with a team member/i.test(aiReply)) {
        return await sendText(from, aiReply);
      }
      // AI had nothing useful -> fall through to the document/selection handlers.
    }
    // ─────────────────────────────────────────────────────────────

    // 1-chiller) APCY-E / APCY-H chiller intents: model lookup, tonnage select,
    //   datasheet, and series/model comparison. Runs in the equipment-SELECTION
    //   band (before Sheet keyword rules) so "chiller"/"ton"/"TR" never get
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
        return await sendNotFoundWithSuggestions(from, text, files);
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
          return await sendNotFoundWithSuggestions(from, text);
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
      return await sendNotFoundWithSuggestions(from, text);
    }

    // 2) Sheet keyword rules (custom overrides / captions)
    const rule = matchRule(text, rules);
    if (rule) return await sendRule(from, rule);

    // From here it's a free-form document lookup (bare code, filename, brand,
    // or a general question). Announce a search unless it's clearly a
    // knowledge/general question (which ends in a chat reply, not a file).
    const isKnowledgeQuestion =
      /\b(hours|open|close|deliver|delivery|price|cost|warranty|install|contact|email|phone|location|address|about|who are you|what do you)\b/i.test(text);
    if (!isKnowledgeQuestion) await announceSearch();

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
        return await sendNotFoundWithSuggestions(from, text, files);
      }
    }

    // A message that names a specific MODEL CODE (5-digit) but matched no real
    // file should NOT get an AI-improvised "details about the unit" reply —
    // unless the user explicitly asked for "detail(s)". So a bare "APMR52090 t1"
    // returns not-found; "APMR52090 detail" opts into the descriptive answer.
    // Genuine knowledge questions (hours/price/etc.) are unaffected.
    const wantsDetail = /\bdetails?\b/i.test(text);
    const hasModelCode = /\d{5}/.test(text);
    if (hasModelCode && !wantsDetail && !isKnowledgeQuestion) {
      console.log(`🚫 model code without "detail" -> not-found (no AI details): "${text}"`);
      return await sendNotFoundWithSuggestions(from, text, files);
    }

    // 3) Product-ish request that filename search missed -> AI matches by meaning
    //    (e.g. "AHU IOM" / "air handling unit" / "do you have the fresh air unit").
    //    Pass only the doc-type-filtered file list so AI never suggests wrong type.
    if (!isKnowledgeQuestion) {
      const aiHits = await aiMatchFile(text, searchFiles);
      if (aiHits && aiHits.length >= 1) {
        console.log(`🤖 AI matched "${text}" -> ${aiHits.map(f => f.name).join(", ")}`);

        // If no doc type was specified and results include both types, ask first
        if (!mentionedDocType) {
          const hasIOM = aiHits.some((f) => fileMatchesDocType(f, "IOM"));
          const hasCat = aiHits.some((f) => fileMatchesDocType(f, "Catalogue"));
          if (hasIOM && hasCat) {
            return await sendButtons(from,
              `Which document type would you like for "${text}"?`,
              [
                { id: `doctype|Catalogue|${text}`, title: "Catalogue" },
                { id: `doctype|IOM|${text}`, title: "IOM" },
              ]
            );
          }
        }

        return await sendFileOptions(from, aiHits, "Did you mean one of these?");
      }
    }

    // 4) General question -> answer from the Knowledge tab via Claude Haiku
    const aiReply = await askClaude(text, knowledge);
    if (aiReply && !/connect you with a team member/i.test(aiReply)) {
      return await sendText(from, aiReply);
    }

    // 5) Nothing matched -> AI suggests related documents, or the standard apology
    await sendNotFoundWithSuggestions(from, text, files);
}

app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  const value = req.body.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  if (!message) return;

  // Drop WhatsApp retries (same message.id re-delivered during cold start).
  if (message.id && isDuplicate(message.id)) {
    console.log(`⚡ Duplicate message ${message.id} — skipped`);
    return;
  }

  enqueue(message.from, async () => {
    try {
      // Resolve who's asking and pin it to this request's async context, so
      // every nested Claude call knows their plan without a threaded flag.
      // loadSheet() is cached for CACHE_MS, so this lookup is effectively free.
      const { accounts } = await loadSheet();
      const account = accounts.get(String(message.from).replace(/\D/g, "")) || null;
      await runWithAccount(account, () => handleIncomingMessage(value, message));
    } catch (err) {
      console.error("Handler error:", err.stack || err.message);
      // Never leave the user with silence on a crash.
      try {
        await sendText(message.from, "⚠️ Something went wrong on my side. Please try that again — or type *menu* to see what I can do.");
      } catch (_) { /* the apology itself failed; nothing more to do */ }
    }
  });
});

app.get("/", (_, res) => res.send("WhatsApp AI bot running ✅"));

// Temporary: list all indexed Drive files so we can update brand-docs.js
// /drive-index            -> everything the bot can see
// /drive-index?q=coil     -> only files/folders matching "coil" (diagnosing
//                            "why can't the bot find X?" without scrolling)
app.get("/drive-index", async (req, res) => {
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
// Diagnostic: is the co-hosted VRF engine reachable, and at which URL?
// ok:true => engine healthy. ok:false + 127.0.0.1 => uvicorn not running in
// this container (check deploy logs / Docker runtime). ok:false + a remote
// onrender.com URL => stale VRF_SIDECAR_URL env var overriding the localhost
// default.
app.get("/vrf-health", async (_, res) => {
  res.json(await require("./vrf/vrfClient.js").sidecarProbe());
});

initVrf({ sendText, sendDocument });
crm.init({ getSheets });
crm.warmUp(); // preload contacts so "Welcome back" works from the first message
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
