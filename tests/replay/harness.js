// Replay harness: runs logged messages through the bot's real server.js with
// every outside service stubbed, and records what the bot would have sent.
//
//   const h = createHarness(deliver);
//   const out = await h.send("100000001", "btn:Catalogue"); // Outbound[]
//
// Outbound = { kind: "text"|"buttons"|"list"|"file", text?, options?: string[], file?: string }
//
// Each createHarness() loads the project's modules afresh, so session state,
// caches and de-dupe tables start empty and a second run in the same process
// matches the first. Time is a virtual clock set from the logged timestamp
// (h.setTime), so session timeouts happen exactly where they did in life.
const fs = require("fs");
const path = require("path");
const Module = require("module");
const os = require("os");

const ROOT = path.join(__dirname, "..", "..");
const fixturePath = (name) => path.join(__dirname, name);
const readFixture = (name) => JSON.parse(fs.readFileSync(fixturePath(name), "utf8"));

const FIXTURES = ["messages.local.json", "sheet.local.json", "drive.local.json"];
const fixturesExist = () => FIXTURES.every((f) => fs.existsSync(fixturePath(f)));

const ADMIN_FALLBACK = "100999999";
const START_TIME = Date.parse("2026-01-01T00:00:00Z");

// "2026-06-12 22:41:05" Qatar time (UTC+3, no DST) -> ms.
const logTime = (t) => Date.parse(String(t).trim().replace(" ", "T") + "+03:00");

// ── what each module must not do for real ────────────────────────────────────
function purgeProjectModules() {
  const skip = [path.join(ROOT, "node_modules"), path.join(ROOT, "tests"), path.join(ROOT, ".claude")];
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(ROOT) && !skip.some((s) => key.startsWith(s))) delete require.cache[key];
  }
}

function stubModule(id, exports) {
  const resolved = require.resolve(id);
  const m = new Module(resolved);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
  return resolved;
}

function createHarness(deliver) {
  if (typeof deliver !== "function") throw new Error("createHarness needs a deliver(value, message) function");
  purgeProjectModules();

  const sheet = readFixture("sheet.local.json");
  const drive = readFixture("drive.local.json");
  const adminNumbers = sheet.adminNumbers && sheet.adminNumbers.length ? sheet.adminNumbers : [ADMIN_FALLBACK];

  // ── environment: dummy values only, and the real .env is never read ───────
  const savedEnv = { ...process.env };
  for (const k of ["VERIFY_TOKEN", "WHATSAPP_ENABLED", "ADMIN_PASSWORD", "SENDER_PIN", "WHATSAPP_REGISTER_PIN"]) delete process.env[k];
  Object.assign(process.env, {
    GOOGLE_SHEET_ID: "dummy-sheet",
    GOOGLE_SERVICE_ACCOUNT_JSON: "dummy",
    WHATSAPP_TOKEN: "dummy-token",
    PHONE_NUMBER_ID: "dummy-phone",
    DRIVE_FOLDER_ID: "dummy-folder",
    CRM_SHEET_ID: "dummy-crm",
    ANTHROPIC_API_KEY: "", // no key: every AI branch takes its "unavailable" path
    ADMIN_NUMBERS: adminNumbers.join(","),
  });
  // The replay must not read the machine's own data folder (its search index in
  // particular): unless the caller chose a DATA_DIR, it gets an empty one.
  let ownDataDir = null;
  if (!process.env.DATA_DIR) {
    ownDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-data-"));
    process.env.DATA_DIR = ownDataDir;
  }
  const dotenvId = stubModule("dotenv", { config: () => ({ parsed: {} }) });

  // ── virtual clock ──────────────────────────────────────────────────────────
  const realNow = Date.now;
  let now = START_TIME;
  Date.now = () => now;

  // ── console: quiet, but keep the errors for the report ────────────────────
  const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const stats = { stale: 0, errors: 0, errorSamples: new Set(), networkBlocked: [], messages: 0 };
  console.log = console.info = console.warn = () => {};
  console.error = (...a) => {
    stats.errors++;
    if (stats.errorSamples.size < 20) stats.errorSamples.add(String(a[0]).slice(0, 120));
  };

  // ── no network at all ──────────────────────────────────────────────────────
  const axios = require("axios");
  const realAxios = { post: axios.post, get: axios.get, request: axios.request };
  const realFetch = globalThis.fetch;
  const blocked = (what) => async (url) => {
    stats.networkBlocked.push(`${what} ${String(url && url.url ? url.url : url).slice(0, 80)}`);
    throw new Error("network blocked by replay harness");
  };
  axios.post = blocked("axios.post");
  axios.get = blocked("axios.get");
  axios.request = blocked("axios.request");
  globalThis.fetch = blocked("fetch");

  // ── recording ──────────────────────────────────────────────────────────────
  let recorded = [];
  let sender = null; // the user whose message is being handled
  const interactive = new Map(); // user -> [{ options: [{id,title,type}] }] newest last
  const adminSet = new Set(adminNumbers.map(String));
  const record = (to, outbound) => {
    const o = { ...outbound };
    if (String(to) !== String(sender)) {
      o.text = `[to ${adminSet.has(String(to)) ? "admin" : "other"}] ${o.text ?? o.file ?? ""}`;
      if (o.kind !== "text") o.kind = "text";
      delete o.options;
      delete o.file;
    }
    recorded.push(o);
    return true;
  };
  const remember = (to, options) => {
    if (String(to) !== String(sender)) return;
    if (!interactive.has(to)) interactive.set(to, []);
    interactive.get(to).push({ options });
  };

  // ── google ────────────────────────────────────────────────────────────────
  const google = require("../../lib/google.js");
  google.getSheets = async () => ({
    spreadsheets: {
      values: {
        batchGet: async ({ ranges }) => ({
          data: {
            valueRanges: ranges.map((r) => {
              const tab = r.split("!")[0];
              const values = tab === "Rules" ? sheet.rules : tab === "Knowledge" ? sheet.knowledge : sheet.allowed;
              return { values: JSON.parse(JSON.stringify(values)) };
            }),
          },
        }),
      },
    },
  });
  google.getDrive = async () => { throw new Error("Drive is stubbed in the replay harness"); };
  google.downloadBytes = async () => Buffer.from("%PDF-1.4 fake drive bytes");

  const driveIndex = require("../../lib/drive-index.js");
  driveIndex.listFolderFiles = async () => drive;

  // ── crm: remembers who has written before, writes nothing ─────────────────
  const crm = require("../../crm.js");
  const seen = new Map();
  crm.init = () => {};
  crm.warmUp = async () => {};
  crm.logInbound = ({ from }) => seen.set(from, (seen.get(from) || 0) + 1);
  crm.logOutbound = () => {};
  crm.isKnownContact = (from) => (seen.get(from) || 0) > 1; // this message is already counted
  crm.statsMessage = async () => "[stats]";
  crm.logDocRequest = async () => true;

  // ── WhatsApp senders: record instead of sending ───────────────────────────
  const wa = require("../../lib/wa.js");
  const payloadOutbound = (payload) => {
    if (payload.type === "text") return { kind: "text", text: payload.text.body };
    if (payload.type === "document" || payload.type === "image") {
      const d = payload[payload.type];
      const file = d.filename || String(d.id).replace(/^media:/, "");
      return { kind: "file", file, ...(d.caption ? { text: d.caption } : {}) };
    }
    const i = payload.interactive;
    if (i.type === "button") {
      const options = i.action.buttons.map((b) => ({ id: b.reply.id, title: b.reply.title, type: "button" }));
      return { kind: "buttons", text: i.body.text, options: options.map((o) => o.title), _taps: options };
    }
    const options = i.action.sections.flatMap((s) => s.rows).map((r) => ({ id: r.id, title: r.title, type: "list" }));
    return { kind: "list", text: i.body.text, options: options.map((o) => o.title), _taps: options };
  };
  const out = (to, payload) => {
    const { _taps, ...o } = payloadOutbound(payload);
    if (_taps) remember(to, _taps);
    return record(to, o);
  };

  const sendText = async (to, body) => out(to, { type: "text", text: { body } });
  Object.assign(wa, {
    send: async (to, payload) => out(to, payload),
    sendText,
    sendLongText: async (to, body, limit = 3800) => { // same chunking as lib/wa.js
      if (!body) return;
      if (body.length <= limit) return await sendText(to, body);
      let chunk = "";
      for (const line of body.split("\n")) {
        if (chunk && (chunk.length + 1 + line.length) > limit) { await sendText(to, chunk); chunk = line; }
        else chunk = chunk ? chunk + "\n" + line : line;
      }
      if (chunk) await sendText(to, chunk);
    },
    // the real payload builders apply WhatsApp's title/row limits and de-dupe
    sendButtons: async (to, body, buttons) => out(to, wa.buildButtonsPayload(to, body, buttons)),
    sendList: async (to, body, label, rows) => out(to, wa.buildListPayload(to, body, label, rows)),
    sendDocument: async (to, buffer, filename, caption) =>
      record(to, { kind: "file", file: filename, ...(caption ? { text: caption } : {}) }),
    sendPdfBuffer: async (to, buffer, filename, caption) =>
      record(to, { kind: "file", file: filename, ...(caption ? { text: caption } : {}) }),
    sendDriveFile: async (to, file) => { record(to, { kind: "file", file: file.name }); },
    uploadMedia: async ({ filename }) => `media:${filename}`,
    uploadMediaBuffer: async (buffer, filename) => `media:${filename}`,
    markReadWithTyping: async () => {},
  });

  // ── send(): one logged message in, the bot's replies out ──────────────────
  async function sendOne(user, logged) {
    const message = { from: user, id: `wamid.replay.${++stats.messages}`, timestamp: String(Math.floor(now / 1000)) };
    const value = { messaging_product: "whatsapp", contacts: [{ wa_id: user }], messages: [message] };

    const tap = /^btn:/.test(logged) ? logged.slice(4) : null;
    if (tap !== null) {
      // The newest interactive message that offers this title wins.
      const history = interactive.get(user) || [];
      let hit = null;
      for (let i = history.length - 1; i >= 0 && !hit; i--) {
        hit = history[i].options.find((o) => o.title.trim() === tap.trim()) || null;
      }
      if (!hit) { stats.stale++; return { stale: true, outbound: [] }; }
      message.type = "interactive";
      message.interactive = hit.type === "button"
        ? { type: "button_reply", button_reply: { id: hit.id, title: hit.title } }
        : { type: "list_reply", list_reply: { id: hit.id, title: hit.title } };
    } else if (logged === "[image]") {
      message.type = "image"; message.image = { id: "media-image", mime_type: "image/jpeg" };
    } else if (logged === "[document]") {
      message.type = "document"; message.document = { id: "media-document", mime_type: "application/pdf" };
    } else if (/^\[[a-z_]+\]$/.test(logged)) {
      message.type = logged.slice(1, -1); // audio, sticker, location ... no payload
    } else {
      message.type = "text"; message.text = { body: logged };
    }

    recorded = [];
    sender = user;
    await deliver(value, message);
    return { stale: false, outbound: recorded };
  }

  return {
    stats,
    /** Replies to one logged message as Outbound[] (a stale tap gets []). */
    async send(user, logged) { return (await sendOne(user, logged)).outbound; },
    /** Like send, but also says whether the tap matched nothing the bot offered. */
    sendDetailed: sendOne,
    setTime(ms) { now = ms; },
    /** Put everything back; call when done. */
    close() {
      Date.now = realNow;
      Object.assign(console, realConsole);
      axios.post = realAxios.post; axios.get = realAxios.get; axios.request = realAxios.request;
      globalThis.fetch = realFetch;
      if (ownDataDir) { // release the files before the folder goes (Windows locks open files)
        try { require("../../lib/db.js").closeDb(); } catch (_) { /* never opened */ }
        try { require("../../lib/page-index.js").getPageIndex().close(); } catch (_) { /* never opened */ }
      }
      delete require.cache[dotenvId];
      for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
      Object.assign(process.env, savedEnv);
      purgeProjectModules();
      if (ownDataDir) {
        try { fs.rmSync(ownDataDir, { recursive: true, force: true }); } catch (_) { /* a locked file in a temp folder */ }
      }
    },
  };
}

// ── delivering to the real server.js, the way the webhook's enqueue does ────
// Part A moved the Allowed check into enqueue, so handleIncomingMessage alone
// does not check the sender: look the account up and run inside it.
function createServerDeliver() {
  const sheet = readFixture("sheet.local.json");
  return async function deliver(value, message) {
    const { handleIncomingMessage } = require("../../server.js");
    const { parseAccounts, findAccount, runWithAccount } = require("../../lib/accounts.js");
    const { runWithChannel, sendText } = require("../../lib/channel.js");
    const { whatsappAdapter } = require("../../lib/channel-whatsapp.js");
    const account = findAccount(message.from, parseAccounts(sheet.allowed));
    if (!account) return; // not on the Allowed tab: no reply at all
    // As in the webhook: WhatsApp is the channel, so the replay goes through the
    // WhatsApp adapter (which reaches the stubbed lib/wa.js senders).
    await runWithChannel(whatsappAdapter, async () => {
      try {
        await runWithAccount(account, () => handleIncomingMessage(value, message));
      } catch (err) {
        console.error("Handler error:", err.stack || err.message);
        try {
          await sendText(message.from, "⚠️ Something went wrong on my side. Please try that again — or type *menu* to see what I can do.");
        } catch (_) { /* nothing more to do */ }
      }
    });
  };
}

/**
 * Replays every logged message in order. Returns one entry per message:
 * { user, logged, stale, outbound }. `info` (optional) receives the stats.
 */
async function replayAll({ info } = {}) {
  const messages = readFixture("messages.local.json");
  const h = createHarness(createServerDeliver());
  try {
    const entries = [];
    for (const m of messages) {
      h.setTime(logTime(m.time));
      const { stale, outbound } = await h.sendDetailed(m.user, m.text);
      entries.push({ user: m.user, logged: m.text, stale, outbound });
    }
    if (info) Object.assign(info, h.stats, { errorSamples: [...h.stats.errorSamples] });
    return entries;
  } finally {
    h.close();
  }
}

module.exports = { createHarness, createServerDeliver, replayAll, fixturesExist, fixturePath, readFixture };
