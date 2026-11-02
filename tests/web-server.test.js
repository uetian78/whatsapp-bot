// The web-related taps in the real server.js (menu rows, Saved work),
// through the replay harness (private fixtures, skipped when they are not on this
// machine). Replies go to a fake web channel; the database is a temp DATA_DIR.
const test = require("node:test");
require("./clean-env.js"); // a DATA_DIR left in the shell must not reach the harness
const assert = require("node:assert");
const { createHarness, fixturesExist } = require("./replay/harness.js");

const skip = !fixturesExist() && "replay fixtures not found (run tests/replay/export-log.js)";
const USER = "100000001";

const textMsg = (body) => ({ type: "text", text: { body } });
const tapMsg = (id, title = "Tap") => ({ type: "interactive", interactive: { type: "button_reply", button_reply: { id, title } } });

// Runs each scripted message through deliverMessage with a fake channel named `name`.
function setup(name = "web") {
  const sent = [];
  const script = [];
  const adapter = {
    name, supports: { rowCheck: true },
    typing: async () => {},
    downloadMedia: async () => { throw new Error("no media"); },
    text: async (to, body) => { sent.push({ kind: "text", body }); return true; },
    longText: async (to, body) => { sent.push({ kind: "text", body }); return true; },
    buttons: async (to, text) => { sent.push({ kind: "buttons", body: text }); return true; },
    list: async (to, text, label, rows) => { sent.push({ kind: "list", body: text, rows }); return true; },
    driveFile: async () => true, generatedFile: async () => true, pageHits: async () => true,
  };
  const h = createHarness(async (value, message) => {
    const { deliverMessage } = require("../server.js");
    const next = script.shift();
    await deliverMessage(value, { from: message.from, id: message.id, timestamp: message.timestamp, ...next }, adapter);
  });
  return {
    sent,
    async say(message) { script.push(message); await h.send(USER, "x"); },
    db: () => require("../lib/db.js"),
    conversations: () => require("../lib/conversations.js").createConversations({ db: require("../lib/db.js").getDb() }),
    done() {
      try { require("../lib/db.js").closeDb(); } catch (_) { /* never opened */ }
      h.close();
    },
    h, script,
  };
}

test("the three menu rows send their tips, by tap and by number", { skip }, async () => {
  const t = setup();
  try {
    const { tipFor } = require("../menu.js");
    await t.say(textMsg("menu"));
    assert.equal(t.sent[0].kind, "list");
    assert.deepEqual(t.sent[0].rows.map((r) => r.id), ["menu|1", "menu|2", "menu|6"]);
    await t.say(textMsg("2"));
    assert.equal(t.sent[1].body, tipFor(2));
    await t.say(textMsg("menu"));
    await t.say(textMsg("3"));
    assert.equal(t.sent[3].body, tipFor(3));
    await t.say(textMsg("menu"));
    await t.say(textMsg("4"));
    assert.match(t.sent[5].body, /between 1 and 3/);
    await t.say(tapMsg("menu|1"));
    assert.equal(t.sent[6].body, tipFor(1));
    await t.say(tapMsg("menu|6"));
    assert.equal(t.sent[7].body, tipFor(3));
  } finally { t.done(); }
});

test("an old menu row gets the no-longer-available reply, with no tip and no crash", { skip }, async () => {
  const t = setup();
  try {
    for (const id of ["menu|3", "menu|4", "menu|5", "menu|9", "menu|"]) {
      const before = t.sent.length;
      await t.say(tapMsg(id, "An old row"));
      assert.equal(t.sent.length, before + 1, id);
      assert.match(t.sent.at(-1).body, /no longer available/, id);
    }
  } finally { t.done(); }
});

test("Saved work lists the newest 10 files again, oldest first, on the web", { skip }, async () => {
  const t = setup();
  try {
    await t.say(textMsg("hello")); // opens the database
    const c = t.conversations();
    for (let i = 1; i <= 12; i++) c.append(USER, "bot", "file", { ref: `drive:f${i}`, name: `File ${i}.pdf`, folder: "x", size: i });
    c.append(USER, "bot", "text", "between");
    const before = c.since(USER, 0, 1000).length;
    t.sent.length = 0;
    await t.say(tapMsg("saved|open", "Saved work"));
    assert.deepEqual(t.sent.map((s) => s.body), ["Your last 10 files, newest at the bottom:"]);
    const added = c.since(USER, 0, 1000).slice(before);
    assert.deepEqual(added.map((m) => m.body.name), Array.from({ length: 10 }, (_, i) => `File ${i + 3}.pdf`));
    assert.ok(added.every((m) => m.role === "bot" && m.kind === "file"));
  } finally { t.done(); }
});

test("tapping Saved work again and again shows the same files, not fewer", { skip }, async () => {
  const t = setup();
  try {
    await t.say(textMsg("hello")); // opens the database
    const c = t.conversations();
    for (let i = 1; i <= 3; i++) c.append(USER, "bot", "file", { ref: `drive:f${i}`, name: `File ${i}.pdf`, folder: "x", size: i });
    const heads = [];
    for (let tap = 0; tap < 3; tap++) {
      t.sent.length = 0;
      await t.say(tapMsg("saved|open", "Saved work"));
      heads.push(t.sent[0].body);
    }
    assert.deepEqual(heads, Array(3).fill("Your last 3 files, newest at the bottom:"));
    assert.equal(c.savedWork(USER, 10).length, 3);
  } finally { t.done(); }
});

test("file choices show their whole names on the web; WhatsApp's own builder still clips them to 24", { skip }, async () => {
  const names = [
    "Submittal Paperwork Mannai Tower Project Chiller Plant A.pdf",
    "Submittal Paperwork Mannai Tower Project Chiller Plant B.pdf",
  ];
  const files = names.map((name, i) => ({ id: `long${i}`, name, folder: "Submittals", mimeType: "application/pdf", size: 1000 }));
  const t = setup();
  try {
    require("../lib/drive-index.js").listFolderFiles = async () => files; // before server.js is first required
    await t.say(textMsg("submittal paperwork mannai tower project chiller plant"));
    const list = t.sent.find((s) => s.kind === "list");
    assert.ok(list, JSON.stringify(t.sent));
    const rows = list.rows.filter((r) => /^fileid\|/.test(r.id));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.title.length > 24), rows.map((r) => r.title).join(" | "));
    const wa = require("../lib/wa.js");
    const sent = wa.buildListPayload("1", "x", "Pick", rows).interactive.action.sections[0].rows;
    assert.ok(sent.every((r) => r.title.length <= 24));
  } finally { t.done(); }
});

const imageMsg = () => ({ type: "image", image: { id: "photo-1", mime_type: "image/jpeg" } });
const docMsg = (mime, filename) => ({ type: "document", document: { id: "doc-1", mime_type: mime, filename } });

test("on the web, a photo or PDF with no flow open starts the schedule flow and says so", { skip }, async () => {
  for (const msg of [imageMsg(), docMsg("application/pdf", "sched.pdf")]) {
    const t = setup();
    try {
      await t.say(msg); // the fake adapter can't download, which is enough to see the flow start
      assert.match(t.sent[0].body, /reading this as an equipment schedule/);
      assert.match(t.sent[1].body, /couldn't download/);
      // The file could not be read, and nobody asked for a schedule, so no flow is left waiting:
      // "cancel" has nothing to cancel.
      await t.say(textMsg("cancel"));
      assert.doesNotMatch(t.sent.at(-1).body, /Cancelled/);
    } finally { t.done(); }
  }
});

test("on the web, a sheet with no flow open is pointed to VRF Selection", { skip }, async () => {
  for (const msg of [
    docMsg("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "rows.xlsx"),
    docMsg("application/vnd.ms-excel", "rows.xls"), docMsg("text/csv", "rows.csv"),
  ]) {
    const t = setup();
    try {
      await t.say(msg);
      assert.equal(t.sent.length, 1);
      assert.match(t.sent[0].body, /VRF Selection/);
      await t.say(textMsg("cancel"));
      assert.doesNotMatch(t.sent.at(-1).body, /Cancelled/, "no flow was started for a sheet");
    } finally { t.done(); }
  }
});

test("on WhatsApp a photo or file with no flow open is still ignored", { skip }, async () => {
  for (const msg of [imageMsg(), docMsg("application/pdf", "sched.pdf"), docMsg("text/csv", "rows.csv")]) {
    const t = setup("whatsapp");
    try {
      await t.say(msg);
      assert.deepEqual(t.sent, []);
    } finally { t.done(); }
  }
});

test("a photo while the schedule flow is open is still read by that flow, with no note", { skip }, async () => {
  const t = setup();
  try {
    await t.say(textMsg("Schedule Selection"));
    t.sent.length = 0;
    await t.say(imageMsg());
    assert.doesNotMatch(t.sent.map((s) => s.body).join("\n"), /reading this as an equipment schedule/);
    assert.match(t.sent[0].body, /couldn't download/);
  } finally { t.done(); }
});

test("Saved work with nothing saved says so", { skip }, async () => {
  const t = setup();
  try {
    await t.say(tapMsg("saved|open", "Saved work"));
    assert.deepEqual(t.sent.map((s) => s.body), ["Nothing saved yet. Files I send you are kept here."]);
  } finally { t.done(); }
});

test("a Saved work tap on WhatsApp is just an unknown tap", { skip }, async () => {
  const t = setup("whatsapp");
  try {
    await t.say(tapMsg("saved|open", "Saved work"));
    assert.match(t.sent[0].body, /no longer available/);
    assert.equal(t.sent.length, 1);
  } finally { t.done(); }
});

test("requiring server.js opens no database and starts nothing", () => {
  const { execFileSync } = require("node:child_process");
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvac-require-"));
  try {
    execFileSync(process.execPath, ["-e", "require('./server.js'); process.exit(0)"], {
      cwd: path.join(__dirname, ".."), env: { ...process.env, DATA_DIR: dir, WEB_SECRET: "", ANTHROPIC_API_KEY: "" }, stdio: "pipe", timeout: 20000,
    });
    assert.deepEqual(fs.readdirSync(dir), [], "nothing was created in DATA_DIR");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the whole thing, over HTTP, through the real server.js ----
const http = require("node:http");

test("a new person's chat opens with the same welcome as typing menu, and typing reaches the real handler", { skip }, async () => {
  const secret = "test-secret-not-real-0000000000001";
  const prev = process.env.WEB_SECRET;
  process.env.WEB_SECRET = secret;
  const h = createHarness(async () => {});
  let server;
  try {
    const { app } = require("../server.js");
    const { makeSession } = require("../web/auth.js");
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const cookie = `hv_session=${makeSession(USER, { secret, now: Date.now })}`;
    const call = (method, path, body) => new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const r = http.request({ host: "127.0.0.1", port: server.address().port, method, path,
        headers: { cookie, ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, json: () => JSON.parse(Buffer.concat(chunks).toString()), headers: res.headers }));
      });
      r.on("error", reject);
      if (data) r.write(data);
      r.end();
    });
    const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };

    const [a, b] = await Promise.all([call("GET", "/app/api/messages"), call("GET", "/app/api/messages")]);
    assert.equal(a.status, 200);
    const first = a.json().messages;
    assert.equal(first.length, 1, "welcomed once");
    assert.equal(b.json().messages.length, 1);
    assert.equal(first[0].role, "bot");
    assert.equal(first[0].kind, "choices");
    assert.deepEqual(first[0].body.choices.map((c) => c.id), ["menu|1", "menu|2", "menu|6"]);
    assert.match(first[0].body.text, /HVAC Assistant/);

    const sent = await call("POST", "/app/api/messages", { text: "menu" });
    assert.equal(sent.status, 202);
    assert.ok(await wait(async () => {
      const r = (await call("GET", `/app/api/messages?after=${first[0].seq}`)).json();
      return r.messages.length >= 2 && !r.busy;
    }));
    const all = (await call("GET", "/app/api/messages")).json().messages;
    assert.deepEqual(all.map((m) => m.role), ["bot", "user", "bot"]);
    assert.equal(all[1].body, "menu");
    assert.deepEqual(all[2].body, first[0].body, "typing menu gives exactly the welcome");

    // a tap the screen would send, with its data
    await call("POST", "/app/api/messages", { tapId: "menu|2", tapTitle: "Chiller and package", data: { x: 1 } });
    assert.ok(await wait(async () => (await call("GET", "/app/api/messages")).json().messages.length >= 5));
    const last = (await call("GET", "/app/api/messages")).json().messages.slice(-2);
    assert.equal(last[0].body, "Chiller and package");
    assert.match(last[1].body, /Chiller & Package Selection/);
  } finally {
    if (server) await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
    try { require("../lib/db.js").closeDb(); } catch (_) { /* never opened */ }
    h.close();
    if (prev === undefined) delete process.env.WEB_SECRET; else process.env.WEB_SECRET = prev;
  }
});
