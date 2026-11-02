// A photo, end to end, with no private fixtures: the real server.js and the real
// routes, web channel, schedule flow and PDF maker. Only the three outside
// services are replaced: the Google Sheet (who is allowed), the AI's HTTP call
// (what the "photo" says), and Drive (nothing in the library). Any other call
// out is refused, so a test can't reach the network by accident.
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

// ---- the three stubs ----
const google = require("../lib/google.js");
google.getSheets = async () => ({
  spreadsheets: { values: { batchGet: async () => ({ data: { valueRanges: [{ values: [] }, { values: [[USER, "Tester"]] }] } }) } },
});
google.getDrive = async () => { throw new Error("Drive is stubbed in this test"); };

const SCHEDULE = [
  { location: "Room 1", type: "SPLIT", category: "split", capacity: 24000, unit: "BTU/HR", qty: 2 },
  { location: "Roof 1", type: "PACKAGE AC", category: "package", capacity: 10, unit: "TR", qty: 1, airflow: 4000, airflowUnit: "CFM" },
];
const aiCalls = [];
let aiRows = SCHEDULE; // what the "photo" says; a test sets [] for a photo with no schedule in it
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url && url.url ? url.url : url);
  if (u.startsWith("http://127.0.0.1")) return realFetch(url, opts); // the test talking to its own server
  if (u === "https://api.anthropic.com/v1/messages") {
    aiCalls.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(aiRows) }] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`blocked call out: ${u}`);
};

const { app } = require("../server.js");
const { makeSession } = require("../web/auth.js");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("[Content_Types].xmlxl/workbook.xml"), Buffer.alloc(32)]);

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
  try { require("../lib/page-index.js").getPageIndex().close(); } catch (_) { /* never opened */ }
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
  globalThis.fetch = realFetch;
});

const call = (method, p, { body, type } = {}) => fetch(base + p, {
  method, redirect: "manual", body,
  headers: { cookie, ...(type ? { "content-type": type } : {}) },
});
const messages = async () => (await (await call("GET", "/app/api/messages")).json());
const say = (text) => call("POST", "/app/api/messages", { body: JSON.stringify({ text }), type: "application/json" });
const tap = (tapId, tapTitle, data) => call("POST", "/app/api/messages", { body: JSON.stringify({ tapId, tapTitle, ...(data ? { data } : {}) }), type: "application/json" });
const upload = (name, bytes) => call("POST", `/app/api/upload?name=${encodeURIComponent(name)}`, { body: bytes, type: "application/octet-stream" });

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

test("a photo with nothing open is read as an equipment schedule and the table comes back", async () => {
  // the first look at the chat gets the welcome; start from there
  await settle();
  const before = (await messages()).messages.length;

  const r = await upload("schedule.jpg", JPEG);
  assert.equal(r.status, 202);
  const msgs = (await settle()).slice(before);

  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[0].body, "schedule.jpg");
  const said = texts(msgs);
  assert.ok(said.some((t) => /reading this as an equipment schedule/.test(t)), said.join(" | "));
  assert.ok(said.some((t) => /Reading the schedule/.test(t)));
  const table = bot(msgs).find((m) => m.kind === "rowcheck");
  assert.ok(table, "the schedule table is shown: " + JSON.stringify(msgs.map((m) => m.kind)));
  assert.equal(table.body.rows.length, 2);
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].messages[0].content[0].type, "image");
  assert.ok(!said.some((t) => /couldn't do anything|Something went wrong/.test(t)), "no catch-all, no apology");
});

test("Looks right continues through the questions to the PDF report, which arrives as a generated file card", async () => {
  const table = bot((await messages()).messages).reverse().find((m) => m.kind === "rowcheck");
  assert.ok(table, "the previous test left a table on screen");
  const data = { tableId: table.body.tableId, rows: table.body.rows };
  assert.ok(data.tableId, "the table carries its id");

  await tap("rows-ok", "Looks right", data);
  let msgs = await settle();
  // Answer whatever the flow asks, from its own words, until a PDF report button appears.
  let printTap = null;
  for (let step = 0; step < 8 && !printTap; step++) {
    const last = bot(msgs).slice(-1)[0];
    const choices = last.kind === "choices" ? last.body.choices : [];
    printTap = choices.find((c) => /print/i.test(c.id) || /pdf/i.test(c.title));
    if (printTap) break;
    const ask = last.kind === "text" ? last.body : (last.body && last.body.text) || "";
    let answer = "1";
    if (/Reply \*1\* for T1/.test(ask) || /T1 \(35/.test(ask)) answer = "1";
    await say(answer);
    msgs = await settle();
  }
  assert.ok(printTap, "a PDF report button was offered: " + JSON.stringify(bot(msgs).slice(-3).map((m) => m.body)));

  const before = msgs.length;
  await tap(printTap.id, printTap.title);
  const after = (await settle()).slice(before);
  const card = bot(after).find((m) => m.kind === "file");
  assert.ok(card, "a file card arrived: " + JSON.stringify(after.map((m) => [m.role, m.kind])));
  assert.match(card.body.ref, /^gen:[0-9a-f-]{36}$/);
  assert.match(card.body.name, /\.pdf$/i);

  const file = await call("GET", `/app/files/${encodeURIComponent(card.body.ref)}`);
  assert.equal(file.status, 200);
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
});

test("a sheet with nothing open is pointed to VRF Selection, not ignored", async () => {
  const before = (await messages()).messages.length;
  const r = await upload("rows.xlsx", XLSX);
  assert.equal(r.status, 202);
  const msgs = (await settle()).slice(before);
  const said = texts(msgs);
  assert.equal(said.length, 1, said.join(" | "));
  assert.match(said[0], /VRF Selection/);
});

test("a tap on a menu row that no longer exists gets the short catch-all reply, once", async () => {
  const { MSG_NO_ANSWER } = require("../web/routes.js");
  const before = (await messages()).messages.length;
  await tap("menu|99", "An old row");
  const msgs = (await settle()).slice(before);
  assert.deepEqual(texts(msgs), [MSG_NO_ANSWER]);
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

// ---- a file while another guided flow is open, and a stray file that can't be read ----
const flows = () => require("../lib/session-store.js");
async function fresh() { // no flow open
  await say("cancel");
  await settle();
  assert.equal(flows().getFlow(USER), null);
}

test("a photo or PDF while a split flow is open leaves that flow exactly as it was, and reads nothing", async () => {
  await fresh();
  await say("Split Selection");
  await settle();
  const before = JSON.stringify(flows().getFlow(USER));
  assert.equal(flows().getFlow(USER).type, "split");
  const calls = aiCalls.length;

  for (const [name, bytes] of [["schedule.jpg", JPEG], ["schedule.pdf", PDF], ["rows.xlsx", XLSX]]) {
    const n = (await messages()).messages.length;
    assert.equal((await upload(name, bytes)).status, 202);
    const said = texts((await settle()).slice(n));
    assert.deepEqual(said, ["Finish this first, or type *cancel* to stop it, then send the file again."], name);
    const flow = flows().getFlow(USER);
    assert.equal(flow.type, "split", name);
    assert.equal(JSON.stringify(flow), before.replace(/"ts":\d+/, `"ts":${flow.ts}`), `${name}: same step, same answers`);
  }
  assert.equal(aiCalls.length, calls, "no AI call");
  await say("cancel"); await settle();
});

test("a photo while an MTZ flow is open leaves that flow exactly as it was, and reads nothing", async () => {
  await fresh();
  await say("MTZ Selection");
  await settle();
  assert.equal(flows().getFlow(USER).type, "mtz");
  const step = flows().getFlow(USER).data.step;
  const calls = aiCalls.length;
  const n = (await messages()).messages.length;
  await upload("schedule.jpg", JPEG);
  const said = texts((await settle()).slice(n));
  assert.deepEqual(said, ["Finish this first, or type *cancel* to stop it, then send the file again."]);
  assert.equal(flows().getFlow(USER).type, "mtz");
  assert.equal(flows().getFlow(USER).data.step, step);
  assert.equal(aiCalls.length, calls);
  // and the flow still works: the next answer is read as the load
  const m = (await messages()).messages.length;
  await say("8.5 TR");
  assert.match(texts((await settle()).slice(m)).join("\n"), /Load: \*102\.0 MBH/);
  await say("cancel"); await settle();
});

test("a stray photo with no schedule in it ends the flow it started, so the next question is not answered with 'send the schedule'", async () => {
  await fresh();
  aiRows = [];
  try {
    const n = (await messages()).messages.length;
    await upload("not-a-schedule.jpg", JPEG);
    const said = texts((await settle()).slice(n));
    assert.ok(said.some((t) => /reading this as an equipment schedule/.test(t)));
    assert.ok(said.some((t) => /didn't find any schedule rows/.test(t)), "the person still hears why: " + said.join(" | "));
    assert.equal(flows().getFlow(USER), null, "the flow it started is closed");

    const m = (await messages()).messages.length;
    await say("hello");
    assert.doesNotMatch(texts((await settle()).slice(m)).join("\n"), /Please send the schedule as an image or PDF/);
  } finally { aiRows = SCHEDULE; }
});

test("a schedule flow started on purpose keeps waiting for the file when a read finds nothing", async () => {
  await fresh();
  await tap("menu|3", "Read a schedule");
  await settle();
  assert.equal(flows().getFlow(USER).type, "schedule");
  aiRows = [];
  try {
    const n = (await messages()).messages.length;
    await upload("blurry.jpg", JPEG);
    const said = texts((await settle()).slice(n));
    assert.ok(said.some((t) => /didn't find any schedule rows/.test(t)));
    assert.equal(flows().getFlow(USER).type, "schedule");
    assert.equal(flows().getFlow(USER).data.step, "awaitImage");
  } finally { aiRows = SCHEDULE; }
  await say("cancel"); await settle();
});

test("the only AI calls were the three photos that were really read", () => {
  // the first test's photo, the stray photo with no schedule in it, the one sent on purpose;
  // the files sent during split and MTZ flows read nothing
  assert.equal(aiCalls.length, 3);
});
