// The web app end to end, with no private fixtures: the real server.js and the real
// routes and web channel. Only the outside services are replaced: the Google Sheet
// (who is allowed) and Drive (nothing in the library). Any other call out is
// refused, so a test can't reach the network by accident.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SECRET = "test-secret-not-real-0000000000001";
const USER = "97455559999";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "hvac-e2e-"));

// ---- environment, before anything is required ----
for (const k of ["DRIVE_FOLDER_ID", "CRM_SHEET_ID", "WHATSAPP_ENABLED", "ADMIN_PASSWORD", "RAILWAY_ENVIRONMENT", "RAILWAY_VOLUME_MOUNT_PATH"]) delete process.env[k];
Object.assign(process.env, {
  DATA_DIR: DATA, WEB_SECRET: SECRET, ANTHROPIC_API_KEY: "test-key-not-real",
  GOOGLE_SHEET_ID: "dummy-sheet", GOOGLE_SERVICE_ACCOUNT_JSON: "{}", PUBLIC_URL: "https://bot.example.test",
});

// server.js loads a .env when there is one; this test must see only the values above.
const Module = require("node:module");
const dotenvPath = require.resolve("dotenv");
const noDotenv = new Module(dotenvPath);
noDotenv.filename = dotenvPath;
noDotenv.loaded = true;
noDotenv.exports = { config: () => ({ parsed: {} }) };
require.cache[dotenvPath] = noDotenv;

// ---- the stubs ----
const google = require("../lib/google.js");
google.getSheets = async () => ({
  spreadsheets: { values: { batchGet: async () => ({ data: { valueRanges: [{ values: [] }, { values: [[USER, "Tester"]] }] } }) } },
});
google.getDrive = async () => { throw new Error("Drive is stubbed in this test"); };

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url && url.url ? url.url : url);
  if (u.startsWith("http://127.0.0.1")) return realFetch(url, opts); // the test talking to its own server
  throw new Error(`blocked call out: ${u}`);
};

const { app } = require("../server.js");
const { makeSession } = require("../web/auth.js");

let server;
let base;
const cookie = `hv_session=${makeSession(USER, { secret: SECRET, now: Date.now })}`;
test.before(async () => {
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  try { require("../lib/db.js").closeDb(); } catch (_) { /* never opened */ }
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
  globalThis.fetch = realFetch;
});

const call = (method, p, { body, type } = {}) => fetch(base + p, {
  method, redirect: "manual", body,
  headers: { cookie, ...(type ? { "content-type": type } : {}) },
});
const messages = async () => (await (await call("GET", "/app/api/messages")).json());
const say = (text) => call("POST", "/app/api/messages", { body: JSON.stringify({ text }), type: "application/json" });
const tap = (tapId, tapTitle) => call("POST", "/app/api/messages", { body: JSON.stringify({ tapId, tapTitle }), type: "application/json" });

// Waits until the bot has settled, then returns everything the chat holds.
async function settle() {
  for (let i = 0; i < 400; i++) {
    const r = await messages();
    if (!r.busy && r.messages.length) return r.messages;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("the bot never settled");
}
const bot = (msgs) => msgs.filter((m) => m.role === "bot");
const texts = (msgs) => bot(msgs).filter((m) => m.kind === "text").map((m) => m.body);

test("a tap on a menu row that no longer exists gets the no-longer-available reply, once", async () => {
  const before = (await messages()).messages.length;
  await tap("menu|99", "An old row");
  const msgs = (await settle()).slice(before);
  const said = texts(msgs);
  assert.equal(said.length, 1, said.join(" | "));
  assert.match(said[0], /no longer available/);
});

test("everyday messages that do get an answer don't also get the catch-all", async () => {
  const { MSG_NO_ANSWER } = require("../web/routes.js");
  for (const text of ["menu", "hello", "cancel", "thanks", "help"]) {
    const before = (await messages()).messages.length;
    await say(text);
    const msgs = (await settle()).slice(before);
    assert.ok(bot(msgs).length >= 1, `"${text}" was answered`);
    assert.ok(!texts(msgs).includes(MSG_NO_ANSWER), `"${text}" got the catch-all`);
  }
});

// ---- what older versions left behind ----
// Messages saved by features that are gone must still be served (the screen shows
// them as a short note), and taps on their old buttons get the usual reply.
const OLD_TAPS = ["rows-ok", "print", "print|1767225600000", "page|1AbCdEf|14|pdf", "page|1AbCdEf|14|image"];

test("old result messages are still served, and an old tap on a removed button gets the no-longer-available reply", async () => {
  await settle();
  const { createConversations } = require("../lib/conversations.js");
  const conversations = createConversations({ db: require("../lib/db.js").getDb() });
  conversations.append(USER, "bot", "rowcheck", { text: "old table", rows: [], skipped: [] });
  conversations.append(USER, "bot", "pages", { prompt: "Pages", hits: [{ fileId: "1AbCdEf", name: "A.pdf", page: 14, snippet: "x" }] });
  const served = (await messages()).messages;
  assert.equal(served.filter((m) => m.kind === "rowcheck").length, 1);
  assert.equal(served.filter((m) => m.kind === "rowcheck")[0].body.text, "old table");
  assert.equal(served.filter((m) => m.kind === "pages")[0].body.hits[0].page, 14);

  for (const id of OLD_TAPS) {
    const before = (await messages()).messages.length;
    assert.equal((await tap(id, "An old button")).status, 202, id);
    const said = texts((await settle()).slice(before));
    assert.equal(said.length, 1, `${id}: ${said.join(" | ")}`);
    assert.match(said[0], /no longer available/, id);
  }
});

