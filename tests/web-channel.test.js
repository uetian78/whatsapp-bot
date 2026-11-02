const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDb } = require("../lib/db.js");
const { createConversations } = require("../lib/conversations.js");
const { createWebChannel } = require("../lib/channel-web.js");
const { pageTapId } = require("../lib/page-extract.js");

const DAY = 24 * 60 * 60 * 1000;

function make(extra = {}) {
  const dir = require("./tmpdirs.js").tmpDir("hvac-web-"); // removed when the run ends, even if a test skips done()
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const db = openDb(":memory:");
  const conversations = createConversations({ db, now });
  const crmCalls = [];
  const crm = { logOutbound: (to, payload) => crmCalls.push([to, payload]) };
  const channel = createWebChannel({ conversations, dataDir: dir, now, crm, ...extra });
  return { dir, clock, db, conversations, channel, crmCalls, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("the adapter has the contract's methods", () => {
  const { channel, done } = make();
  assert.equal(channel.name, "web");
  for (const m of ["typing", "downloadMedia", "text", "longText", "buttons", "list", "driveFile", "generatedFile", "pageHits"]) {
    assert.equal(typeof channel[m], "function", m);
  }
  done();
});

test("creating the channel makes no folders", () => {
  const dir = path.join(os.tmpdir(), `hvac-web-never-${process.pid}`);
  const { conversations } = make();
  createWebChannel({ conversations, dataDir: dir, now: Date.now });
  assert.equal(fs.existsSync(dir), false);
});

test("typing does nothing and never rejects", async () => {
  const { channel, conversations, done } = make();
  assert.equal(await channel.typing("whatever"), undefined);
  await channel.typing(undefined);
  assert.equal(conversations.isEmpty("u1"), true);
  done();
});

test("text stores a bot text message and returns true", async () => {
  const { channel, conversations, done } = make();
  assert.equal(await channel.text("u1", "hello"), true);
  const [m] = conversations.since("u1", 0);
  assert.equal(m.role, "bot");
  assert.equal(m.kind, "text");
  assert.equal(m.body, "hello");
  done();
});

test("longText stays one message", async () => {
  const { channel, conversations, done } = make();
  const long = ("line of text\n").repeat(1000);
  await channel.longText("u1", long);
  const rows = conversations.since("u1", 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, long);
  done();
});

test("longText with an empty body stores nothing", async () => {
  const { channel, conversations, done } = make();
  assert.equal(await channel.longText("u1", ""), undefined);
  assert.equal(conversations.isEmpty("u1"), true);
  done();
});

test("buttons and list both become choices with id, title and description", async () => {
  const { channel, conversations, done } = make();
  await channel.buttons("u1", "Pick one", [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta", description: "second" }]);
  await channel.list("u1", "Pick from list", "Choose", [{ id: "x", title: "Xray", description: "first row" }]);
  const [b, l] = conversations.since("u1", 0);
  assert.equal(b.kind, "choices");
  assert.deepEqual(b.body, {
    text: "Pick one",
    choices: [{ id: "a", title: "Alpha", description: "" }, { id: "b", title: "Beta", description: "second" }],
  });
  assert.equal(l.kind, "choices");
  assert.deepEqual(l.body, {
    text: "Pick from list", label: "Choose",
    choices: [{ id: "x", title: "Xray", description: "first row" }],
  });
  done();
});

test("driveFile stores ref, name, folder and size and resolves truthy", async () => {
  const { channel, conversations, done } = make();
  const result = await channel.driveFile("u1", { id: "F1", name: "Spec.pdf", folder: "Trane", size: 1234, exportMime: null });
  assert.ok(result);
  const [m] = conversations.since("u1", 0);
  assert.equal(m.kind, "file");
  assert.deepEqual(m.body, { ref: "drive:F1", name: "Spec.pdf", folder: "Trane", size: 1234 });
  done();
});

test("pageHits stores a pages message with file ref, page, snippet and the tap ids", async () => {
  const { channel, conversations, done } = make();
  const hits = [{ fileId: "F1", name: "Manual.pdf", folder: "Carrier", page: 7, snippet: "sound level 62 dB", size: 5000 }];
  assert.equal(await channel.pageHits("u1", "Found it:", hits), true);
  const [m] = conversations.since("u1", 0);
  assert.equal(m.kind, "pages");
  assert.equal(m.body.prompt, "Found it:");
  assert.deepEqual(m.body.hits, [{
    ref: "drive:F1", fileId: "F1", name: "Manual.pdf", folder: "Carrier", page: 7,
    snippet: "sound level 62 dB", size: 5000,
    pdfTap: pageTapId("F1", 7, "pdf"), imageTap: pageTapId("F1", 7, "image"),
  }]);
  done();
});

test("pageHits with no hits stores nothing and resolves false", async () => {
  const { channel, conversations, done } = make();
  assert.equal(await channel.pageHits("u1", "x", []), false);
  assert.equal(conversations.isEmpty("u1"), true);
  done();
});

test("generatedFile saves bytes under the data dir and returns a gen ref", async () => {
  const { channel, conversations, dir, done } = make();
  const bytes = Buffer.from("%PDF-1.4 hello");
  assert.ok(await channel.generatedFile("u1", bytes, "Submittal.pdf", "Here you go"));
  const [m] = conversations.since("u1", 0);
  assert.equal(m.kind, "file");
  assert.match(m.body.ref, /^gen:[0-9a-f-]{36}$/);
  assert.equal(m.body.name, "Submittal.pdf");
  assert.equal(m.body.size, bytes.length);
  assert.equal(m.body.mime, "application/pdf");
  assert.equal(m.body.caption, "Here you go");
  const id = m.body.ref.slice(4);
  const got = channel.readGenerated(id, "u1");
  assert.equal(got.name, "Submittal.pdf");
  assert.equal(got.mime, "application/pdf");
  assert.ok(got.path.startsWith(path.join(dir, "generated")));
  assert.deepEqual(fs.readFileSync(got.path), bytes);
  done();
});

test("generated mime comes from the filename extension", async () => {
  const { channel, conversations, done } = make();
  await channel.generatedFile("u1", Buffer.from("a"), "photo.JPG");
  await channel.generatedFile("u1", Buffer.from("b"), "sel.xlsx");
  await channel.generatedFile("u1", Buffer.from("c"), "thing.bin");
  const mimes = conversations.since("u1", 0).map((m) => m.body.mime);
  assert.deepEqual(mimes, [
    "image/jpeg",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",
  ]);
  done();
});

test("another user cannot read a generated file", async () => {
  const { channel, conversations, done } = make();
  await channel.generatedFile("u1", Buffer.from("x"), "a.pdf");
  const id = conversations.since("u1", 0)[0].body.ref.slice(4);
  assert.notEqual(channel.readGenerated(id, "u1"), null);
  assert.equal(channel.readGenerated(id, "other"), null);
  done();
});

test("readGenerated rejects ids that are not uuids and missing files", async () => {
  const { channel, conversations, done } = make();
  assert.equal(channel.readGenerated("../../etc/passwd", "u1"), null);
  assert.equal(channel.readGenerated("", "u1"), null);
  assert.equal(channel.readGenerated(undefined, "u1"), null);
  await channel.generatedFile("u1", Buffer.from("x"), "a.pdf");
  const id = conversations.since("u1", 0)[0].body.ref.slice(4);
  fs.unlinkSync(channel.readGenerated(id, "u1").path);
  assert.equal(channel.readGenerated(id, "u1"), null);
  done();
});

test("generated files older than 30 days are removed at startup", async () => {
  const { channel, conversations, clock, db, done } = make();
  await channel.generatedFile("u1", Buffer.from("old"), "old.pdf");
  clock.t += 29 * DAY;
  await channel.generatedFile("u1", Buffer.from("new"), "new.pdf");
  clock.t += 2 * DAY; // old is now 31 days, new is 2
  const [oldMsg, newMsg] = conversations.since("u1", 0);
  const oldId = oldMsg.body.ref.slice(4), newId = newMsg.body.ref.slice(4);
  const oldPath = channel.readGenerated(oldId, "u1").path;
  channel.cleanupGenerated();
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(channel.readGenerated(oldId, "u1"), null);
  assert.notEqual(channel.readGenerated(newId, "u1"), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM generated_files").get().n, 1);
  // the saved message stays
  assert.equal(conversations.since("u1", 0).length, 2);
  done();
});

test("generated files are kept under GENERATED_MAX_MB, oldest first", async () => {
  const prev = process.env.GENERATED_MAX_MB;
  process.env.GENERATED_MAX_MB = "1";
  const { channel, conversations, clock, done } = make();
  try {
    const mb = (n) => Buffer.alloc(Math.floor(n * 1024 * 1024), 1);
    await channel.generatedFile("u1", mb(0.6), "a.pdf");
    clock.t += 1000;
    await channel.generatedFile("u1", mb(0.6), "b.pdf");
    clock.t += 1000;
    await channel.generatedFile("u1", mb(0.3), "c.pdf");
    const ids = conversations.since("u1", 0).map((m) => m.body.ref.slice(4));
    channel.cleanupGenerated();
    assert.equal(channel.readGenerated(ids[0], "u1"), null); // oldest goes first
    assert.notEqual(channel.readGenerated(ids[1], "u1"), null);
    assert.notEqual(channel.readGenerated(ids[2], "u1"), null);
  } finally {
    if (prev === undefined) delete process.env.GENERATED_MAX_MB; else process.env.GENERATED_MAX_MB = prev;
    done();
  }
});

test("cleanupGenerated with no generated folder does nothing", () => {
  const { channel, done } = make();
  assert.doesNotThrow(() => channel.cleanupGenerated());
  done();
});

test("downloadMedia returns the uploaded bytes for that upload id", async () => {
  const bytes = Buffer.from("photo");
  const uploads = { get: (id) => (id === "up1" ? { buffer: bytes, mediaType: "image/jpeg" } : null) };
  const { channel, done } = make({ uploads });
  assert.deepEqual(await channel.downloadMedia("up1"), { buffer: bytes, mediaType: "image/jpeg" });
  await assert.rejects(() => channel.downloadMedia("nope"), /upload/i);
  done();
});

test("downloadMedia rejects clearly when there is no upload store", async () => {
  const { channel, done } = make();
  await assert.rejects(() => channel.downloadMedia("up1"), /upload/i);
  done();
});

test("each reply is logged to the CRM in the shape wa.js sends", async () => {
  const { channel, crmCalls, done } = make();
  await channel.text("u1", "hello");
  await channel.longText("u1", "long body");
  await channel.buttons("u1", "Pick", [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }]);
  await channel.list("u1", "List", "Choose", [{ id: "x", title: "Xray" }]);
  await channel.driveFile("u1", { id: "F1", name: "Spec.pdf", folder: "T", size: 1 });
  await channel.driveFile("u1", { id: "F2", name: "Photo.png", folder: "T", size: 1 });
  await channel.generatedFile("u1", Buffer.from("x"), "S.pdf", "cap");
  const payloads = crmCalls.map(([to, p]) => { assert.equal(to, "u1"); return p; });
  assert.deepEqual(payloads[0], { messaging_product: "whatsapp", to: "u1", type: "text", text: { preview_url: true, body: "hello" } });
  assert.equal(payloads[1].text.body, "long body");
  assert.equal(payloads[2].type, "interactive");
  assert.deepEqual(payloads[2].interactive.action.buttons.map((b) => b.reply.title), ["Alpha", "Beta"]);
  assert.equal(payloads[3].type, "interactive");
  assert.equal(payloads[3].interactive.type, "list");
  assert.equal(payloads[4].type, "document");
  assert.equal(payloads[4].document.filename, "Spec.pdf");
  assert.equal(payloads[5].type, "image");
  assert.equal(payloads[6].type, "document");
  assert.equal(payloads[6].document.filename, "S.pdf");
  assert.equal(payloads[6].document.caption, "cap");
  done();
});

test("a CRM failure never breaks the reply", async () => {
  const { channel, conversations, done } = make({ crm: { logOutbound: () => { throw new Error("sheet down"); } } });
  assert.equal(await channel.text("u1", "still here"), true);
  assert.equal(conversations.since("u1", 0)[0].body, "still here");
  done();
});

test("the CRM defaults to the real crm.js when none is given", async () => {
  const { conversations, dir, done } = make();
  const channel = createWebChannel({ conversations, dataDir: dir, now: Date.now });
  assert.equal(await channel.text("nobody-pending", "hi"), true);
  done();
});

// ---- a Drive file with no size ----
test("the library lookup may be async", async () => {
  const { channel, conversations, done } = make({ findLibraryFile: async () => ({ size: 9 }) });
  await channel.driveFile("u1", { id: "F1", name: "Spec.pdf" });
  assert.equal(conversations.since("u1", 0)[0].body.size, 9);
  done();
});

test("driveFile with no size looks it up in the library by id", async () => {
  const asked = [];
  const { channel, conversations, done } = make({ findLibraryFile: (id) => { asked.push(id); return { id, name: "Spec.pdf", size: 5981665 }; } });
  await channel.driveFile("u1", { id: "F1", name: "Spec.pdf" });
  const [m] = conversations.since("u1", 0);
  assert.deepEqual(m.body, { ref: "drive:F1", name: "Spec.pdf", folder: null, size: 5981665 });
  assert.deepEqual(asked, ["F1"]);
  done();
});

test("driveFile keeps a size it was given and does not look anything up", async () => {
  const { channel, conversations, done } = make({ findLibraryFile: () => { throw new Error("should not be asked"); } });
  await channel.driveFile("u1", { id: "F1", name: "Spec.pdf", folder: "T", size: 1234 });
  assert.equal(conversations.since("u1", 0)[0].body.size, 1234);
  done();
});

test("an unknown size stays null: not in the library, a library error, or a library record without one", async () => {
  for (const find of [() => null, () => { throw new Error("library down"); }, () => ({ id: "F1", name: "x" })]) {
    const { channel, conversations, done } = make({ findLibraryFile: find });
    const result = await channel.driveFile("u1", { id: "F1", name: "Spec.pdf" });
    assert.ok(result);
    assert.equal(conversations.since("u1", 0)[0].body.size, null);
    done();
  }
});

test("with no library lookup given and no Drive folder set, a missing size is null and nothing is opened", async () => {
  const saved = process.env.DRIVE_FOLDER_ID;
  delete process.env.DRIVE_FOLDER_ID;
  try {
    const { channel, conversations, done } = make();
    await channel.driveFile("u1", { id: "F1", name: "Spec.pdf" });
    assert.equal(conversations.since("u1", 0)[0].body.size, null);
    done();
  } finally { if (saved !== undefined) process.env.DRIVE_FOLDER_ID = saved; }
});
