// ============================================================
//  WhatsApp Auto-Responder + Claude Haiku AI Fallback
//  - Google Sheet = control panel (rules + AI knowledge)
//  - Keyword rules answer common questions for FREE
//  - Claude Haiku answers everything else using YOUR knowledge only
// ============================================================

const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");
const FormData = require("form-data");
const { buildSelectionReply, buildSelectionInteractive, handleButtonTap, interpretCode, parseSeriesRequest, seriesMenu, parseDatasheetRequest, datasheetMenu, detectDocType } = require("./products.js");
const { detectSeriesEntry, filenameFor, folderToDocType, datasheetFolderForSeries, datasheetCondition, DATASHEET_FOLDERS } = require("./catalogue-map.js");
const { routeChillerText, handleChillerButton } = require("./chillers.js");
const { findBrandDocs } = require("./brand-docs.js");
const { isMenuTrigger, welcomeMenu, tipFor, MENU_HINT } = require("./menu.js");
const { PRODUCT_KB, parseListRequest, buildUnitList } = require("./product-facts.js");
const { generateMtzPdf } = require("./mtz-pdf.js");
const { isVrfTrigger } = require("./vrf/trigger.js");
const {
  initVrf, onVrfKeyword, onVrfMessage, sessions: vrfSessions,
} = require("./vrf/vrfHandler.js");
require("dotenv").config();

const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  ANTHROPIC_API_KEY,
  GOOGLE_SHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON, // full service-account JSON as one env var
  DRIVE_FOLDER_ID,             // parent folder the bot searches (recursively)
  PORT = 3000,
} = process.env;

const GRAPH_URL = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ============================================================
//  GOOGLE SHEET ACCESS
//  Sheet has 3 tabs:
//   1) "Rules"     -> Keywords | Match | Type | Caption | FileLink | Filename
//   2) "Knowledge" -> Topic | Info   (the AI's knowledge base)
//   3) "Allowed"   -> Number        (optional whitelist; empty = reply to all)
// ============================================================
let sheetsClient = null;
let driveClient = null;

async function getGoogleAuth() {
  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
}

async function getSheets() {
  if (sheetsClient) return sheetsClient;
  const auth = await getGoogleAuth();
  sheetsClient = google.sheets({ version: "v4", auth: await auth.getClient() });
  return sheetsClient;
}

async function getDrive() {
  if (driveClient) return driveClient;
  const auth = await getGoogleAuth();
  driveClient = google.drive({ version: "v3", auth: await auth.getClient() });
  return driveClient;
}

// Extract a Drive file ID from any Drive link.
function driveFileId(link) {
  if (!link) return null;
  const m = link.match(/\/d\/([a-zA-Z0-9_-]+)/) || link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ---- Recursive listing of all PDFs under the parent folder (cached) ----
// Lets the bot find files by name without any sheet entry. Drop a PDF in the
// folder (or any subfolder) and it becomes requestable automatically.
let fileIndex = { files: [], ts: 0 };
const FILE_CACHE_MS = 2 * 60 * 1000; // refresh at most every 2 minutes

// Stores numbered-list selections per user so they can reply "1", "2", etc.
const pendingLists = {}; // { [from]: File[] }

// Stores an open welcome menu per user so a numbered reply maps to a tip.
const pendingMenu = {}; // { [from]: { options, ts } }
const MENU_TTL_MS = 15 * 60 * 1000; // a menu reply is only honoured for 15 min

// Stores multi-step MTZ selection sessions per user.
// { step, reqTC, db, wb, amb, airflow, project, tag, ts }
const pendingMtz = {};  // { [from]: object }
const MTZ_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const VRF_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes


async function listFolderFiles() {
  if (!DRIVE_FOLDER_ID) return [];
  if (Date.now() - fileIndex.ts < FILE_CACHE_MS && fileIndex.files.length) {
    return fileIndex.files;
  }

  const drive = await getDrive();
  const collected = [];
  // Track each folder's name so we know which folder a file lives in
  // (e.g. "Catalogue", "IOM", "Datasheets"). The parent folder itself
  // is recorded under its own name too.
  // folderPaths stores the FULL path for each folder id, e.g.
  // "Catalogues/Hisense VRF" — so a file inside a brand sub-folder still
  // inherits the "Catalogues" ancestor and passes the doc-type filter.
  const folderPaths = { [DRIVE_FOLDER_ID]: "(root)" };
  const toVisit = [DRIVE_FOLDER_ID];
  let foldersVisited = 0;

  while (toVisit.length) {
    const folderId = toVisit.shift();
    foldersVisited++;
    let pageToken;
    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType)",
        pageSize: 100,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of res.data.files || []) {
        if (f.mimeType === "application/vnd.google-apps.folder") {
          // Build full path so nested folders inherit their ancestors' names
          const parentPath = folderPaths[folderId] || "(root)";
          folderPaths[f.id] = parentPath === "(root)" ? f.name : `${parentPath}/${f.name}`;
          console.log(`   ↳ subfolder found: ${folderPaths[f.id]} (${f.id})`);
          toVisit.push(f.id);
        } else if (f.mimeType === "application/pdf" || /\.(pdf|png|jpe?g)$/i.test(f.name)) {
          collected.push({ id: f.id, name: f.name, folder: folderPaths[folderId] || "(root)" });
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }

  fileIndex = { files: collected, ts: Date.now() };
  console.log(
    `🗂️  Indexed ${collected.length} files across ${foldersVisited} folder(s): ` +
    collected.map((f) => `${f.folder}/${f.name}`).join(", ")
  );
  return collected;
}

// Find the right file for a series + doc type.
//
// IMPORTANT design facts (from the real Drive layout):
//   - The DOC TYPE is decided by the FOLDER, not the filename:
//       * Catalogue files live in a folder named "Catalogue(s)" and are named
//         just by series, e.g. "APMR-A.pdf", "APCY-H.pdf", "ACMR.pdf".
//         (No word "Catalogue" in the filename.)
//       * IOM files live in a folder named "IOM(s)" and DO carry "IOM" in the
//         name, e.g. "ACMR IOM.pdf", "APMRA 2025 IOM.pdf".
//   - So we match the FOLDER for the doc type, then match only the SERIES
//     prefix within the filename. Any extra tokens (year, version, stray
//     dots like "APMR-A. 2025.pdf") are ignored.
//
// Detect doc type from filename suffix — _IOM.pdf or _catalogue.pdf.
// This is the primary signal now that all files are renamed consistently.
function docTypeFromFilename(filename) {
  const n = (filename || "").toLowerCase();
  if (n.endsWith("_iom.pdf")) return "IOM";
  if (n.endsWith("_catalogue.pdf")) return "Catalogue";
  return null;
}

// docType is "Catalogue" or "IOM". Match by folder path (any segment), not just
// the immediate parent — so files in "Catalogues/Hisense VRF/" still count as Catalogues.
function folderMatchesDocType(folderPath, docType) {
  // Split full path (e.g. "Catalogues/Hisense VRF") and check each segment.
  const segments = (folderPath || "").split("/").map((s) => s.toLowerCase().trim());
  if (docType === "Catalogue") return segments.some((s) => /^catalogues?$/.test(s) || /^catalog$/.test(s));
  if (docType === "IOM") return segments.some((s) => /^ioms?$/.test(s));
  return false;
}

function fileMatchesDocType(file, docType) {
  return folderMatchesDocType(file.folder, docType) || docTypeFromFilename(file.name) === docType;
}

function findFilesInFolder(seriesName, files, docType) {
  const inFolder = files.filter((f) => fileMatchesDocType(f, docType));

  const norm = (s) => s.toLowerCase().replace(/[\s\-_.]/g, "");
  const seriesToken = norm(seriesName); // e.g. "apmra" for "APMR-A"
  const docWord = docType.toLowerCase(); // "catalogue" or "iom"

  const scored = [];
  for (const f of inFolder) {
    const base = norm(f.name.replace(/\.[^.]+$/, "")); // e.g. "apmra2025", "acmriom"
    if (!base.startsWith(seriesToken)) continue; // series must lead the name

    // Prevent a shorter series matching a longer one (APMR vs APMR-A).
    // The char right after the series prefix must NOT be a letter — UNLESS
    // those letters are the doc-type word itself (e.g. "acmr" + "iom" ->
    // "acmriom" is valid; "apmr" + "a..." is NOT valid for series APMR).
    const after = base.slice(seriesToken.length); // e.g. "2025", "iom", "a2025iom"
    if (/^[a-z]/.test(after) && !after.startsWith(docWord)) continue;

    // Rank: exact series name first (e.g. "apmra"), then series + doc word
    // (e.g. "acmriom"), then series + other extras (e.g. "apmra2025"). This
    // makes "APMR-A.pdf" win over "APMR-A. 2025.pdf" when both exist.
    let rank = 2;
    if (base === seriesToken) rank = 0;
    else if (after.startsWith(docWord)) rank = 1;
    scored.push({ f, rank });
  }

  if (!scored.length) return [];
  const best = Math.min(...scored.map((s) => s.rank));
  return scored.filter((s) => s.rank === best).map((s) => s.f);
}

// Find files whose name matches the user's text.
// Normalizes by removing spaces/dashes so "52015", "PAC4A 52015", "pac4a52015" all match.
// Prefers exact base-name matches over partial ones.
function findFilesByName(text, files) {
  const norm = (s) => s.toLowerCase().replace(/[\s\-_.]/g, "");
  const q = norm(text.trim());
  if (!q) return [];

  const scored = [];
  for (const f of files) {
    const base = norm(f.name.replace(/\.[^.]+$/, ""));
    if (base === q) scored.push({ f, rank: 0 });          // exact
    else if (base.includes(q)) scored.push({ f, rank: 1 }); // query inside name
    else if (q.includes(base)) scored.push({ f, rank: 2 }); // name inside query
  }
  if (!scored.length) return [];

  // If any exact matches exist, return only those.
  const best = Math.min(...scored.map((s) => s.rank));
  return scored.filter((s) => s.rank === best).map((s) => s.f);
}

// Simple cache so we don't hit the Sheet on every single message
let cache = { rules: [], knowledge: [], allowed: [], ts: 0 };
const CACHE_MS = 60 * 1000; // refresh at most once per minute

async function loadSheet() {
  if (Date.now() - cache.ts < CACHE_MS && cache.rules.length) return cache;

  const sheets = await getSheets();
  const ranges = ["Rules!A2:F", "Knowledge!A2:B", "Allowed!A2:A"];
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

  const allowed = allowRows.map((r) => (r[0] || "").replace(/\D/g, "")).filter(Boolean);

  cache = { rules, knowledge, allowed, ts: Date.now() };
  console.log(`🔄 Sheet loaded: ${rules.length} rules, ${knowledge.length} knowledge rows`);
  return cache;
}

// Convert a normal Drive share link into a reliable direct-download link.
// Uses drive.usercontent.google.com with confirm=t, which bypasses the
// "can't scan for viruses" warning page that corrupts downloads.
function normalizeDriveLink(link) {
  if (!link) return "";
  const m = link.match(/\/d\/([a-zA-Z0-9_-]+)/) || link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (link.includes("drive.google.com") && m) {
    return `https://drive.usercontent.google.com/download?id=${m[1]}&export=download&confirm=t`;
  }
  return link; // already direct, or a GitHub/other link
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

// Find keywords closest to the user's text, to suggest when nothing matched.
// Returns up to `limit` suggestion keywords (first keyword of each near rule).
function closestKeywords(text, rules, limit = 5) {
  const full = text.trim().toLowerCase();
  const words = full.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const rule of rules) {
    if (rule.matchType === "exact") continue; // skip the greeting/menu rule
    let best = Infinity;
    for (const kw of rule.keywords) {
      const kwWords = kw.split(/\s+/);
      for (const w of words) {
        // direct containment either way counts as very close
        if (kw.includes(w) || w.includes(kw)) best = Math.min(best, 0.1);
        if (kwWords.some((kwW) => kwW === w)) best = Math.min(best, 0.0);
        const norm = levenshtein(w, kw) / Math.max(w.length, kw.length);
        if (norm < best) best = norm;
      }
      const d2 = levenshtein(full, kw) / Math.max(full.length, kw.length);
      if (d2 < best) best = d2;
    }
    if (best <= 0.5) scored.push({ kw: rule.keywords[0], score: best });
  }
  scored.sort((a, b) => a.score - b.score);
  const seen = new Set();
  const out = [];
  for (const s of scored) {
    if (!seen.has(s.kw)) { seen.add(s.kw); out.push(s.kw); }
    if (out.length >= limit) break;
  }
  return out;
}

const NOT_FOUND_MSG = "Cannot find requested file — Email hassan.saleem@mannai.com.qa to get the required file.\n\n" + MENU_HINT;

// Build a friendly "did you mean" message, or a full menu if nothing is close.
function suggestionMessage(text, rules) {
  const near = closestKeywords(text, rules);
  if (near.length) {
    const list = near.map((k) => `• ${k.toUpperCase()}`).join("\n");
    return `I couldn't find an exact match for "${text}". Here are the closest documents I have:\n${list}\n\nReply with a keyword above, or email hassan.saleem@mannai.com.qa if you need something else.`;
  }
  // nothing close at all -> standard apology
  return NOT_FOUND_MSG;
}

// ============================================================
//  CLAUDE HAIKU FALLBACK
//  Answers ONLY from the Knowledge tab. Refuses to invent.
// ============================================================
async function askClaude(question, knowledge) {
  if (!ANTHROPIC_API_KEY) return null;

  const knowledgeText = knowledge.join("\n");

  const system = `You are a helpful WhatsApp assistant for an HVAC equipment supplier.
Answer the customer's question using ONLY the information below (business info + product specifications).
Keep replies short, friendly, and suitable for WhatsApp (2-4 sentences max).
When quoting a product spec, give the exact figure and its units, and name the model (e.g. "APMR 52340 at T3: 24.9 TR / 87.6 kW, 10500 CFM").
If the information does not contain the answer, reply exactly:
"Let me connect you with a team member who can help with that."
Do NOT make up prices, products, capacities, or details — only use the numbers given.

--- BUSINESS INFORMATION ---
${knowledgeText}
--- END INFORMATION ---

--- PRODUCT SPECIFICATIONS ---
${PRODUCT_KB}
--- END SPECIFICATIONS ---`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system,
      messages: [{ role: "user", content: question }],
    });
    return msg.content?.[0]?.text?.trim() || null;
  } catch (err) {
    console.error("Claude error:", err.message);
    return null;
  }
}

// Use Claude to match a user's request to the best file when filename search
// misses (handles synonyms, e.g. "AHU" / "air handling unit" -> MAH.pdf).
// Returns the matching file object, or null if none fits.
async function aiMatchFile(text, files) {
  if (!ANTHROPIC_API_KEY || !files.length) return null;

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
  if (!ANTHROPIC_API_KEY || !folderFiles.length) return null;

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
    return null;
  }
}

// Find an indexed file by its EXACT name within a given doc-type folder.
// Folder is matched via the catalogue-map's folderToDocType (handles
// "Catalogues"/"Catalogue" and "IOM"/"IOMs"). Filename match is exact, but
// tolerant of a stray trailing space (Drive has "APCNVVH .pdf").
function findExactFileInDoc(exactName, docType, files) {
  if (!exactName) return null;
  const want = exactName.trim().toLowerCase();
  for (const f of files) {
    if (f.name.trim().toLowerCase() !== want) continue;
    if (folderToDocType(f.folder) === docType || docTypeFromFilename(f.name) === docType) return f;
  }
  return null;
}

// Find datasheet files for a series + code. Looks only inside that series'
// datasheet subfolder(s) and matches files whose name contains the 5-digit
// code. Returns an array of { name, id, condition } (condition = T1/T3/null).
function findDatasheetFiles(series, code, files) {
  const out = [];
  for (const f of files) {
    if (!datasheetFolderForSeries(f.folder, series)) continue;
    // the code must appear in the filename
    const re = new RegExp(`\\b${code}\\b`);
    if (!re.test(f.name)) continue;
    out.push({ name: f.name, id: f.id, condition: datasheetCondition(f.name) });
  }
  return out;
}

// Chiller datasheets: the 4-digit code is embedded in the model string
// (e.g. "APCY5530TH..."), so word-boundaries don't apply. Match by checking
// any path segment against the series' datasheet folder names and the code as
// a substring of the normalized filename. Returns matching file objects.
function findChillerDatasheetFiles(series, code, files) {
  const aliases = DATASHEET_FOLDERS[series] || [];
  const out = [];
  for (const f of files) {
    const segs = (f.folder || "").toLowerCase().split("/").map((s) => s.trim());
    if (!segs.some((s) => aliases.includes(s))) continue;
    const norm = f.name.toLowerCase().replace(/[\s\-_.]/g, "");
    if (norm.includes(code)) out.push(f);
  }
  return out;
}

// Dispatch a chiller response descriptor from chillers.js (text / buttons /
// datasheet fetch). Keeps logging to the matched model/intent only.
async function sendChillerResponse(from, r) {
  if (!r) return;
  if (r.type === "text") return await sendText(from, r.text);
  if (r.type === "buttons") return await sendButtons(from, r.text, r.buttons);
  if (r.type === "datasheet") {
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
async function resolveSeriesFile(seriesNameOrText, docType, files) {
  // 1) Deterministic map by exact filename.
  const entry = detectSeriesEntry(seriesNameOrText);
  if (entry) {
    const exact = filenameFor(entry, docType); // exact filename or null
    if (exact) {
      const hit = findExactFileInDoc(exact, docType, files);
      if (hit) {
        console.log(`📖 Map: ${entry.name} ${docType} -> ${hit.name}`);
        return hit;
      }
      console.log(`⚠️  Map expected "${exact}" in ${docType} but it wasn't indexed (cache/rename?). Falling back.`);
    } else {
      // The map KNOWS this series has no file of this type. Be honest.
      console.log(`ℹ️  ${entry.name} has no ${docType} on file.`);
      return null;
    }
  }

  // 2) Safety net: old prefix matcher, then AI (for unmapped series).
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
async function sendText(to, body) {
  return send(to, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { preview_url: true, body },
  });
}

// Send a long body in order, split on line breaks to stay under WhatsApp's
// 4096-char message limit (used for full unit lists).
async function sendLongText(to, body, limit = 3800) {
  if (!body) return;
  if (body.length <= limit) return await sendText(to, body);
  const lines = body.split("\n");
  let chunk = "";
  for (const line of lines) {
    if (chunk && (chunk.length + 1 + line.length) > limit) {
      await sendText(to, chunk);
      chunk = line;
    } else {
      chunk = chunk ? chunk + "\n" + line : line;
    }
  }
  if (chunk) await sendText(to, chunk);
}

// Send up to 3 tappable reply buttons. buttons = [{id, title}, ...].
// Titles are capped at 20 chars (WhatsApp limit).
async function sendButtons(to, bodyText, buttons) {
  const trimmed = buttons.slice(0, 3).map((b) => ({
    type: "reply",
    reply: { id: b.id, title: b.title.slice(0, 20) },
  }));
  return send(to, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText.slice(0, 1024) },
      action: { buttons: trimmed },
    },
  });
}

// Download a file (e.g. from Google Drive) and re-upload it to WhatsApp's
// media endpoint with the correct content-type. WhatsApp then labels it
// correctly (e.g. .pdf) instead of a generic .bin. Returns a media ID.
const MEDIA_URL = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`;

const EXT_MIME = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function mimeFromName(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return EXT_MIME[ext] || "application/octet-stream";
}

// Download a file. Accepts either {link} or {fileId}. For Drive, downloads
// via the Drive API using the service account (reliable, no virus-scan page).
async function downloadBytes({ link, fileId }) {
  const id = fileId || (link ? driveFileId(link) : null);

  if (id) {
    const drive = await getDrive();
    const res = await drive.files.get(
      { fileId: id, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    );
    return Buffer.from(res.data);
  }

  // Non-Drive link: direct HTTP download.
  const r = await axios.get(link, { responseType: "arraybuffer", maxRedirects: 5 });
  return Buffer.from(r.data);
}

async function uploadMedia({ link, fileId, filename }) {
  const buffer = await downloadBytes({ link, fileId });
  const mime = mimeFromName(filename);

  // sanity check: a real PDF starts with "%PDF"
  if (mime === "application/pdf") {
    const sig = buffer.slice(0, 5).toString("utf8");
    if (!sig.startsWith("%PDF")) {
      throw new Error(
        `Downloaded file is not a valid PDF (got ${buffer.length} bytes starting "${sig}"). ` +
        `Check the bot's access to this file.`
      );
    }
  }

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mime });
  form.append("type", mime);

  const up = await axios.post(MEDIA_URL, form, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, ...form.getHeaders() },
  });
  return up.data.id; // media ID
}

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

// Send a file found in the Drive folder, by its Drive ID.
async function sendDriveFile(to, file) {
  const isImage = /\.(png|jpe?g)$/i.test(file.name);
  const niceName = file.name.replace(/\.[^.]+$/, "");
  const caption = `Here is ${niceName} 📄`;
  try {
    const mediaId = await uploadMedia({ fileId: file.id, filename: file.name });
    if (isImage) {
      return send(to, {
        messaging_product: "whatsapp", to, type: "image",
        image: { id: mediaId, caption },
      });
    }
    return send(to, {
      messaging_product: "whatsapp", to, type: "document",
      document: { id: mediaId, filename: file.name, caption },
    });
  } catch (err) {
    console.error("❌ Drive file send error:", err.response?.data || err.message);
    return sendText(to, NOT_FOUND_MSG);
  }
}

async function sendRule(to, rule) {
  if (rule.type === "document") {
    try {
      const mediaId = await uploadMedia({ link: rule.fileLink, filename: rule.filename });
      return send(to, {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: { id: mediaId, filename: rule.filename, caption: rule.caption },
      });
    } catch (err) {
      console.error("❌ Document upload error:", err.response?.data || err.message);
      return sendText(
        to,
        NOT_FOUND_MSG
      );
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

async function send(to, payload) {
  try {
    await axios.post(GRAPH_URL, payload, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    });
    console.log(`✅ Sent ${payload.type} to ${to}`);
  } catch (err) {
    console.error("❌ Send error:", err.response?.data || err.message);
  }
}

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

// Clean display name: strip _IOM / _catalogue suffix and extension.
function displayName(file) {
  return file.name
    .replace(/_IOM\.pdf$/i, "")
    .replace(/_catalogue\.pdf$/i, "")
    .replace(/\.pdf$/i, "")
    .trim();
}

// Send multiple file matches smartly:
//   1 match  → send it directly
//   2-3      → WhatsApp reply buttons (tappable)
//   4+       → numbered text list (user replies "1", "2", …)
async function sendFileOptions(to, matchedFiles, prompt) {
  if (matchedFiles.length === 1) return sendDriveFile(to, matchedFiles[0]);

  if (matchedFiles.length <= 3) {
    const buttons = matchedFiles.map((f) => ({
      id: `fileid|${f.id}`,
      title: displayName(f).slice(0, 20),
    }));
    return sendButtons(to, prompt || "Which one would you like?", buttons);
  }

  // 4+ options: numbered list stored for next reply (supersedes any open menu)
  delete pendingMenu[to];
  pendingLists[to] = matchedFiles;
  const list = matchedFiles.map((f, i) => `${i + 1}. ${displayName(f)}`).join("\n");
  return sendText(to, `${prompt || "I found several matches:"}\n\n${list}\n\nReply with a number to get the file.`);
}


// ============================================================
//  TRANE MTZ STEP HANDLER
// ============================================================
const TR_TO_MBH = 12; // 1 TR = 12 MBtu/h

function parseMbh(text) {
  // Accept: "100", "100 MBH", "8 TR", "8.5 ton", "8.5 tons"
  const t = text.toLowerCase().trim();
  const trMatch = t.match(/^([\d.]+)\s*(?:tr|ton|tons)$/);
  if (trMatch) return parseFloat(trMatch[1]) * TR_TO_MBH;
  const numMatch = t.match(/^([\d.]+)\s*(?:mbh|mbtu\/h|mbtuh)?$/);
  if (numMatch) return parseFloat(numMatch[1]);
  return null;
}

function parseTempPair(text) {
  // Accept: "80/67", "80 67", "80,67", "db80 wb67", "80°F / 67°F"
  const nums = text.match(/[\d.]+/g);
  if (nums && nums.length >= 2) return { db: parseFloat(nums[0]), wb: parseFloat(nums[1]) };
  return null;
}

function parseNum(text) {
  const m = text.match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

async function handleMtzStep(from, text) {
  const s = pendingMtz[from];

  // Auto-cancel if session is older than 10 minutes
  if (Date.now() - s.ts > MTZ_TIMEOUT_MS) {
    delete pendingMtz[from];
    return sendText(from, "⏰ MTZ session timed out. Type *MTZ* to start a new selection.");
  }

  const cancel = /^(cancel|stop|exit|quit|reset)\b/i.test(text.trim());
  if (cancel) {
    delete pendingMtz[from];
    return sendText(from, "✅ MTZ selection cancelled. Type *MTZ* anytime to start again.");
  }

  // ── Step 1: required cooling load ───────────────────────────
  if (s.step === "load") {
    const mbh = parseMbh(text);
    if (!mbh || mbh <= 0) {
      return sendText(from,
        "❌ Couldn't parse that. Please enter the required total cooling load.\n" +
        "Examples: `100` (MBtu/h), `120 MBH`, `8.5 TR`\n" +
        "Type *cancel* to exit."
      );
    }
    s.reqTC = mbh;
    s.step  = "conditions";
    return sendText(from,
      `✅ Load: *${mbh.toFixed(1)} MBtu/h* (${(mbh / TR_TO_MBH).toFixed(2)} TR)\n\n` +
      "*Step 2/4:* What are the *on-coil conditions*?\n" +
      "Reply with dry-bulb and wet-bulb temperatures in °F — e.g. `80/67`\n" +
      "_(Typical: DB 80°F / WB 67°F)_"
    );
  }

  // ── Step 2: on-coil DB / WB ─────────────────────────────────
  if (s.step === "conditions") {
    const pair = parseTempPair(text);
    if (!pair || pair.db < 60 || pair.db > 100 || pair.wb < 50 || pair.wb > 85 || pair.wb > pair.db) {
      return sendText(from,
        "❌ Couldn't parse that. Enter DB and WB in °F, e.g. `80/67`\n" +
        "DB range 60–100°F · WB range 50–85°F · WB must be ≤ DB\n" +
        "Type *cancel* to exit."
      );
    }
    s.db   = pair.db;
    s.wb   = pair.wb;
    s.step = "ambient";
    return sendText(from,
      `✅ On-coil: *DB ${pair.db}°F / WB ${pair.wb}°F*\n\n` +
      "*Step 3/4:* What is the *outdoor ambient temperature*? (°F)\n" +
      "Reply with a number, e.g. `115`\n" +
      "_(Table range: 85–125°F. Typical Qatar/Gulf: 115–125°F)_"
    );
  }

  // ── Step 3: ambient ─────────────────────────────────────────
  if (s.step === "ambient") {
    const amb = parseNum(text);
    if (!amb || amb < 70 || amb > 135) {
      return sendText(from,
        "❌ Enter ambient temp in °F, e.g. `115`. Range: 70–135°F.\nType *cancel* to exit."
      );
    }
    s.amb  = amb;
    s.step = "airflow";
    return sendText(from,
      `✅ Ambient: *${amb}°F*\n\n` +
      "*Step 4/4:* What is the *supply airflow*? (CFM)\n" +
      "Reply with a CFM value, e.g. `2800`\n" +
      "Or reply *rated* to use each model's catalogue rated airflow."
    );
  }

  // ── Step 4: airflow → generate PDF ──────────────────────────
  if (s.step === "airflow") {
    const useRated = /^rated$/i.test(text.trim());
    const cfm = useRated ? null : parseNum(text);
    if (!useRated && (!cfm || cfm < 500 || cfm > 20000)) {
      return sendText(from,
        "❌ Enter airflow in CFM (500–20000), e.g. `2800`\nOr reply *rated* to use catalogue rated airflow.\nType *cancel* to exit."
      );
    }
    s.airflow = cfm;
    delete pendingMtz[from];

    await sendText(from,
      `✅ Airflow: *${cfm ? cfm + " CFM" : "rated (catalogue)"}*\n\n` +
      "⏳ Generating your MTZ selection datasheet... please wait a moment."
    );

    console.log(`📊 MTZ selection: reqTC=${s.reqTC} DB=${s.db} WB=${s.wb} amb=${s.amb} airflow=${s.airflow}`);

    let pdfBuffer;
    try {
      pdfBuffer = await generateMtzPdf({
        reqTC:   s.reqTC,
        db:      s.db,
        wb:      s.wb,
        amb:     s.amb,
        airflow: s.airflow,
        project: s.project || "",
        tag:     s.tag     || "",
      });
    } catch (err) {
      console.error("❌ MTZ PDF error:", err.message);
      return sendText(from, "❌ Failed to generate the datasheet. Please try again or contact support.");
    }

    if (!pdfBuffer) {
      return sendText(from, "❌ No MTZ model found for those conditions. Please try different values.");
    }

    // Upload the PDF buffer to WhatsApp media and send as document
    try {
      const fd = new FormData();
      fd.append("messaging_product", "whatsapp");
      fd.append("type", "application/pdf");
      fd.append("file", pdfBuffer, { filename: "MTZ_Selection.pdf", contentType: "application/pdf" });

      const uploadRes = await axios.post(
        `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`,
        fd,
        { headers: { ...fd.getHeaders(), Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
      );
      const mediaId = uploadRes.data.id;

      await send(from, {
        messaging_product: "whatsapp",
        to: from,
        type: "document",
        document: {
          id: mediaId,
          filename: "MTZ_Selection_Datasheet.pdf",
          caption: `Trane MTZ Selection — ${(s.reqTC / TR_TO_MBH).toFixed(1)} TR @ DB${s.db}/WB${s.wb}°F, ${s.amb}°F amb`,
        },
      });
    } catch (err) {
      console.error("❌ MTZ send error:", err.message);
      return sendText(from, "❌ PDF was generated but could not be sent. Please try again.");
    }
  }
}

// ============================================================
//  WEBHOOK RECEIVER
// ============================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;

    // --- Button tap? (interactive reply) ---
    if (message.type === "interactive" && message.interactive?.type === "button_reply") {
      const btnId = message.interactive.button_reply.id;
      console.log(`🔘 ${from} tapped: ${btnId}`);

      // Chiller buttons (chmodel|, chsel|, chds|) -> series pick / spec / datasheet.
      const chillerBtn = handleChillerButton(btnId);
      if (chillerBtn) return await sendChillerResponse(from, chillerBtn);

      const action = handleButtonTap(btnId);
      if (action?.type === "interactive") {
        return await sendButtons(from, action.text, action.buttons);
      }
      // Catalogue / IOM choice -> fetch from that folder ONLY
      if (action?.type === "folderFile") {
        const files = await listFolderFiles();
        const file = await resolveSeriesFile(action.series, action.docType, files);
        if (file) return await sendDriveFile(from, file);
        return await sendText(
          from,
          NOT_FOUND_MSG
        );
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
        return await sendText(
          from,
          NOT_FOUND_MSG
        );
      }
      // Doc-type choice button: "doctype|IOM|<query>" or "doctype|Catalogue|<query>"
      if (btnId.startsWith("doctype|")) {
        const [, docType, ...queryParts] = btnId.split("|");
        const query = queryParts.join("|");
        const files = await listFolderFiles();
        const filtered = files.filter((f) => fileMatchesDocType(f, docType));
        const aiHits = await aiMatchFile(query, filtered);
        if (aiHits && aiHits.length >= 1) return await sendFileOptions(from, aiHits, `${docType} — which product?`);
        return await sendText(from, NOT_FOUND_MSG);
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
        return await sendText(from, NOT_FOUND_MSG);
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

    if (message.type !== "text") return;
    const text = message.text.body.trim();

    // Numeric reply to a pending numbered list ("1", "2", etc.)
    if (/^\d+$/.test(text) && pendingLists[from]) {
      const idx = parseInt(text, 10) - 1;
      const list = pendingLists[from];
      delete pendingLists[from];
      if (idx >= 0 && idx < list.length) {
        console.log(`🔢 ${from} selected #${idx + 1}: ${list[idx].name}`);
        return await sendDriveFile(from, list[idx]);
      }
      return await sendText(from, `Please reply with a number between 1 and ${list.length}.`);
    }

    // ── MTZ multi-step session ─────────────────────────────────
    if (pendingMtz[from]) {
      return await handleMtzStep(from, text);
    }
    // Trigger word: "mtz", "trane mtz", "mtz selection", "mtz selector"
    if (/\bmtz\b/i.test(text)) {
      pendingMtz[from] = { step: "load", ts: Date.now() };
      return await sendText(from,
        "🌡️ *Trane MTZ Package Unit Selector*\n\n" +
        "I'll walk you through 4 quick questions to find the best model and generate a datasheet PDF.\n\n" +
        "*Step 1/4:* What is your required total cooling load?\n" +
        "Reply with a number in *MBtu/h* or add TR — e.g. `100` or `8.5 TR`"
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
    if (/^\d+$/.test(text) && pendingMenu[from] && Date.now() - pendingMenu[from].ts < MENU_TTL_MS) {
      const { options } = pendingMenu[from];
      const n = parseInt(text, 10);
      const tip = tipFor(n, options);
      if (tip) {
        console.log(`📋 ${from} menu pick ${n}`);
        return await sendText(from, tip);
      }
      return await sendText(from, `Please reply with a number between 1 and ${options.length}, or type *menu*.`);
    }
    // Greeting / "menu" / "help" -> show the welcome menu (numbered list).
    if (isMenuTrigger(text)) {
      console.log(`📋 welcome menu -> ${from}`);
      delete pendingLists[from];
      const m = welcomeMenu();
      pendingMenu[from] = { options: m.options, ts: Date.now() };
      return await sendText(from, m.text);
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

    // ── List units in a series ───────────────────────────────────
    // "give me list of APMR units", "list all DMP models", "what chillers do
    // you have" -> every model in that series with capacity + airflow.
    const listReq = parseListRequest(text);
    if (listReq) {
      console.log(`📋 unit list: ${listReq.join(", ")}`);
      const body = buildUnitList(listReq);
      if (body) return await sendLongText(from, body);
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
        return await sendText(from, NOT_FOUND_MSG);
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
        const menu = seriesMenu(seriesReq.series);
        // Only one document type exists -> send it directly, no extra tap.
        if (menu.only) {
          console.log(`📚 Series single-doc: ${menu.only.series} ${menu.only.docType}`);
          await announceSearch("🔍 Fetching that document…");
          const files = await listFolderFiles();
          const file = await resolveSeriesFile(menu.only.series, menu.only.docType, files);
          if (file) return await sendDriveFile(from, file);
          return await sendText(
            from,
            NOT_FOUND_MSG
          );
        }
        // No buttons (nothing on file) -> just send the text.
        if (!menu.buttons || !menu.buttons.length) {
          return await sendText(from, menu.text);
        }
        console.log(`📚 Series menu: ${seriesReq.series}`);
        return await sendButtons(from, menu.text, menu.buttons);
      }
      // direct: user named both series and doc type
      console.log(`📚 Series direct: ${seriesReq.series} ${seriesReq.docType}`);
      await announceSearch("🔍 Fetching that document…");
      const files = await listFolderFiles();
      const file = await resolveSeriesFile(seriesReq.series, seriesReq.docType, files);
      if (file) return await sendDriveFile(from, file);
      return await sendText(
        from,
        NOT_FOUND_MSG
      );
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
        return await sendText(from, NOT_FOUND_MSG);
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
      return await sendText(from, NOT_FOUND_MSG);
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

    // 5) Nothing matched -> show closest documents if any, otherwise standard apology
    await sendText(from, suggestionMessage(text, rules));
  } catch (err) {
    console.error("Handler error:", err.message);
  }
});

app.get("/", (_, res) => res.send("WhatsApp AI bot running ✅"));

// Temporary: list all indexed Drive files so we can update brand-docs.js
app.get("/drive-index", async (_, res) => {
  try {
    const files = await listFolderFiles();
    const grouped = {};
    for (const f of files) {
      if (!grouped[f.folder]) grouped[f.folder] = [];
      grouped[f.folder].push(f.name);
    }
    let out = `Total: ${files.length} files\n\n`;
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
initVrf({ sendText, sendDocument });
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
