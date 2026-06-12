// ============================================================
//  CRM — logs every interaction to a Google Sheet
//  Tabs (auto-created with headers on first run):
//   "Log"      -> Time (Qatar) | Phone | Name | Message | Intent | Bot response
//   "Contacts" -> Phone | Name | First seen | Last seen | Messages |
//                 Files received | Last intent | Last message
//
//  Design rules:
//  - NEVER slows or breaks the bot: every write is fire-and-forget,
//    queued and debounced; all errors are caught and logged only.
//  - Intent is classified deterministically by reusing the same parsers
//    the router uses — zero AI cost.
// ============================================================

const { parseDatasheetRequest, buildSelectionInteractive, parseSeriesRequest, interpretCode } = require("./products.js");
const { routeChillerText } = require("./chillers.js");
const { parseListRequest } = require("./product-facts.js");
const { isMenuTrigger } = require("./menu.js");
const { isVrfTrigger } = require("./vrf/trigger.js");

const CRM_SHEET_ID = process.env.CRM_SHEET_ID || "1EbAXIZrjaelovg8APOaWhdg7FVnLxyO6-I2bMzIE2JM";
const TZ = "Asia/Qatar";

const LOG_HEADERS = ["Time (Qatar)", "Phone", "Name", "Message", "Intent", "Bot response"];
const CONTACT_HEADERS = ["Phone", "Name", "First seen", "Last seen", "Messages", "Files received", "Last intent", "Last message"];

let getSheetsClient = null; // injected from server.js (shares its auth)
let tabsReady = false;

// "2026-06-12 22:41:05" in Qatar time — sortable as text.
function nowQatar() {
  return new Date().toLocaleString("sv-SE", { timeZone: TZ });
}

function init({ getSheets }) {
  getSheetsClient = getSheets;
}

// ── Intent classification (deterministic, mirrors the router) ──
function classify(text) {
  const t = (text || "").trim();
  if (!t) return "empty";
  if (/^\[(image|document|audio|video|sticker)\]$/.test(t)) return "media";
  if (t.startsWith("btn:")) return "button-tap";
  if (/^\d+$/.test(t)) return "numbered-reply";
  if (isMenuTrigger(t)) return "menu";
  if (/^stats$/i.test(t)) return "admin-stats";
  if (isVrfTrigger(t)) return "vrf-selection";
  if (/\bmtz\b/i.test(t)) return "mtz-selection";
  // Mirror the router's order: list-units and spec questions are intercepted
  // BEFORE chiller/datasheet/selection routing.
  try { if (parseListRequest(t)) return "list-units"; } catch (_) {}
  const mentionsDoc = /\b(datasheet|data ?sheet|catalog(?:ue)?|iom|manual|brochure|drawing|pdf|document|file)\b/i.test(t);
  if (!mentionsDoc && (/\?/.test(t) || /\b(what|whats|what's|how many|how much|which|tell me|explain|compare|difference|capacity|cooling|airflow|eer|iplv|tonnage|weight|dimensions?|sound|dba|refrigerant)\b/i.test(t))) {
    return "question";
  }
  try { if (routeChillerText(t)) return "chiller"; } catch (_) {}
  try { if (parseDatasheetRequest(t)) return "datasheet"; } catch (_) {}
  try { if (buildSelectionInteractive(t)) return "selection"; } catch (_) {}
  try { if (parseSeriesRequest(t)) return "catalogue-iom"; } catch (_) {}
  try { if (interpretCode(t)) return "model-code"; } catch (_) {}
  if (mentionsDoc) return "doc-search";
  if (/\b(price|cost|warranty|deliver|contact|hours)\b/i.test(t)) return "question";
  return "other";
}

// ── Per-message pending records (collect outbounds, then commit) ──
const pending = {};   // { [from]: { ts, from, name, text, intent, responses, files, timer } }
const COMMIT_AFTER_MS = 8000; // give slow flows (uploads) time to attach replies

function logInbound({ from, name, text }) {
  try {
    // A second message before commit -> commit the previous one now.
    if (pending[from]) commit(from);
    const rec = {
      ts: nowQatar(),
      from,
      name: name || "",
      text: (text || "").slice(0, 300),
      intent: classify(text),
      responses: [],
      files: 0,
    };
    rec.timer = setTimeout(() => commit(from), COMMIT_AFTER_MS);
    if (rec.timer.unref) rec.timer.unref();
    pending[from] = rec;
  } catch (e) {
    console.error("CRM logInbound error:", e.message);
  }
}

// Called from the central send() — derives a short summary of what went out.
function logOutbound(to, payload) {
  try {
    const rec = pending[to];
    if (!rec) return;
    let summary = "";
    if (payload.type === "document") {
      summary = `📄 ${payload.document?.filename || "document"}`;
      rec.files++;
    } else if (payload.type === "image") {
      summary = `🖼️ ${(payload.image?.caption || "image").slice(0, 60)}`;
      rec.files++;
    } else if (payload.type === "interactive") {
      const titles = (payload.interactive?.action?.buttons || []).map((b) => b.reply?.title).filter(Boolean);
      summary = `buttons: ${titles.join(" | ")}`.slice(0, 80);
    } else if (payload.type === "text") {
      summary = (payload.text?.body || "").replace(/\s+/g, " ").slice(0, 80);
    }
    if (summary && rec.responses.length < 3) rec.responses.push(summary);
  } catch (e) {
    console.error("CRM logOutbound error:", e.message);
  }
}

function commit(from) {
  const rec = pending[from];
  if (!rec) return;
  delete pending[from];
  if (rec.timer) clearTimeout(rec.timer);
  logQueue.push([rec.ts, rec.from, rec.name, rec.text, rec.intent, rec.responses.join(" || ") || "(no reply)"]);
  upsertContact(rec);
  scheduleFlush();
}

// ── Contacts (in-memory map, lazily loaded, rewritten on flush) ──
let contacts = null; // Map phone -> {name, first, last, messages, files, lastIntent, lastMsg}
let contactsDirty = false;

async function loadContacts(sheets) {
  if (contacts) return;
  contacts = new Map();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: CRM_SHEET_ID,
      range: "Contacts!A2:H",
    });
    for (const r of res.data.values || []) {
      if (r[0]) contacts.set(String(r[0]), {
        name: r[1] || "", first: r[2] || "", last: r[3] || "",
        messages: parseInt(r[4], 10) || 0, files: parseInt(r[5], 10) || 0,
        lastIntent: r[6] || "", lastMsg: r[7] || "",
      });
    }
  } catch (e) {
    console.error("CRM loadContacts error:", e.message);
  }
}

function upsertContact(rec) {
  if (!contacts) contacts = new Map(); // sheet copy merges on next flush load
  const c = contacts.get(rec.from) || { name: "", first: rec.ts, messages: 0, files: 0 };
  if (rec.name) c.name = rec.name;
  c.last = rec.ts;
  c.messages += 1;
  c.files += rec.files;
  c.lastIntent = rec.intent;
  c.lastMsg = rec.text.slice(0, 100);
  contacts.set(rec.from, c);
  contactsDirty = true;
}

// True if we have seen this number before this message (powers "Welcome back").
function isKnownContact(from) {
  return !!(contacts && contacts.get(from) && contacts.get(from).messages > 0);
}

// ── Sheet writes (queued + debounced; never throws) ──
const logQueue = [];
let flushTimer = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush().catch((e) => console.error("CRM flush error:", e.message)); }, 3000);
  if (flushTimer.unref) flushTimer.unref();
}

async function ensureTabs(sheets) {
  if (tabsReady) return;
  const meta = await sheets.spreadsheets.get({ spreadsheetId: CRM_SHEET_ID });
  const titles = (meta.data.sheets || []).map((s) => s.properties.title);
  const requests = [];
  if (!titles.includes("Log")) requests.push({ addSheet: { properties: { title: "Log" } } });
  if (!titles.includes("Contacts")) requests.push({ addSheet: { properties: { title: "Contacts" } } });
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: CRM_SHEET_ID, requestBody: { requests } });
  }
  // (Re)write headers — idempotent.
  await sheets.spreadsheets.values.update({
    spreadsheetId: CRM_SHEET_ID, range: "Log!A1:F1", valueInputOption: "RAW",
    requestBody: { values: [LOG_HEADERS] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: CRM_SHEET_ID, range: "Contacts!A1:H1", valueInputOption: "RAW",
    requestBody: { values: [CONTACT_HEADERS] },
  });
  tabsReady = true;
}

async function flush() {
  if (!getSheetsClient) return;
  if (!logQueue.length && !contactsDirty) return;
  const sheets = await getSheetsClient();
  await ensureTabs(sheets);
  await loadContacts(sheets);

  if (logQueue.length) {
    const rows = logQueue.splice(0, logQueue.length);
    await sheets.spreadsheets.values.append({
      spreadsheetId: CRM_SHEET_ID, range: "Log!A:F",
      valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });
    console.log(`📊 CRM: logged ${rows.length} interaction(s)`);
  }

  if (contactsDirty) {
    contactsDirty = false;
    const rows = [...contacts.entries()].map(([phone, c]) => [
      phone, c.name, c.first, c.last, c.messages, c.files, c.lastIntent, c.lastMsg,
    ]);
    if (rows.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: CRM_SHEET_ID, range: `Contacts!A2:H${rows.length + 1}`,
        valueInputOption: "RAW", requestBody: { values: rows },
      });
    }
  }
}

// ── "stats" admin command — usage summary from the Log tab ──
async function statsMessage() {
  try {
    const sheets = await getSheetsClient();
    await ensureTabs(sheets);
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: CRM_SHEET_ID, range: "Log!A2:F" });
    const rows = res.data.values || [];
    const today = nowQatar().slice(0, 10);
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 10);

    const week = rows.filter((r) => (r[0] || "").slice(0, 10) >= cutoff);
    const todayRows = week.filter((r) => (r[0] || "").slice(0, 10) === today);

    const count = (list, idx) => {
      const m = {};
      for (const r of list) { const k = r[idx] || "?"; m[k] = (m[k] || 0) + 1; }
      return Object.entries(m).sort((a, b) => b[1] - a[1]);
    };
    const topUsers = count(week, 2).slice(0, 5)
      .map(([name, n], i) => `${i + 1}. ${name || "(no name)"} — ${n}`).join("\n");
    const topIntents = count(week, 4).slice(0, 5)
      .map(([k, n]) => `• ${k}: ${n}`).join("\n");
    const notFound = week.filter((r) => /cannot find/i.test(r[5] || "")).length;
    // Responses are " || "-joined segments; real file sends START with 📄/🖼️
    // (a text reply may merely contain the emoji — don't count those).
    const fileSegs = (resp) => (resp || "").split(" || ").filter((s) => /^(📄|🖼️) /.test(s.trim()));
    const filesSent = week.reduce((s, r) => s + fileSegs(r[5]).length, 0);

    // Busiest hour of the week (Qatar time)
    const byHour = count(week.map((r) => [(r[0] || "").slice(11, 13)]), 0);
    const busiest = byHour.length ? `${byHour[0][0]}:00 (${byHour[0][1]} requests)` : "—";

    // Top documents actually delivered
    const docCount = {};
    for (const r of week) {
      for (const seg of fileSegs(r[5])) {
        const name = seg.trim().replace(/^(📄|🖼️) /, "");
        docCount[name] = (docCount[name] || 0) + 1;
      }
    }
    const topDocs = Object.entries(docCount).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([d, n]) => `• ${d} — ${n}×`).join("\n");

    // Latest unanswered request, so the admin can act immediately
    const lastMiss = [...week].reverse().find((r) => /cannot find/i.test(r[5] || ""));

    return (
      `📊 *Bot usage*\n` +
      `━━━━━━━━━━━━━━\n` +
      `Today: *${todayRows.length}* requests · *${new Set(todayRows.map((r) => r[1])).size}* users\n` +
      `Last 7 days: *${week.length}* requests · *${new Set(week.map((r) => r[1])).size}* users\n` +
      `Files sent (7d): *${filesSent}*  |  Busiest hour: ${busiest}\n\n` +
      `*Top users (7d):*\n${topUsers || "—"}\n\n` +
      `*Top request types (7d):*\n${topIntents || "—"}\n\n` +
      `*Most-sent documents (7d):*\n${topDocs || "—"}\n\n` +
      `⚠️ Not-found (7d): *${notFound}*` +
      (lastMiss ? `\nLatest miss: "${(lastMiss[3] || "").slice(0, 60)}" — ${lastMiss[2] || lastMiss[1]}` : "") +
      `\n\n📈 Dashboard: https://docs.google.com/spreadsheets/d/${CRM_SHEET_ID}`
    );
  } catch (e) {
    console.error("CRM stats error:", e.message);
    return "📊 Stats are unavailable right now — check that the CRM sheet is shared with the bot's service account (Editor).";
  }
}

// Preload contacts at boot so "Welcome back" works from the first message.
async function warmUp() {
  try {
    if (!getSheetsClient) return;
    const sheets = await getSheetsClient();
    await ensureTabs(sheets);
    await loadContacts(sheets);
    console.log(`📊 CRM ready (${contacts ? contacts.size : 0} known contacts)`);
  } catch (e) {
    console.error("CRM warmUp error:", e.message, "— is the sheet shared with the service account as Editor?");
  }
}

module.exports = { init, classify, logInbound, logOutbound, isKnownContact, statsMessage, warmUp };
