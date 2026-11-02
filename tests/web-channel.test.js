const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDb } = require("../lib/db.js");
const { createConversations } = require("../lib/conversations.js");
const { createWebChannel } = require("../lib/channel-web.js");

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
  for (const m of ["typing", "text", "longText", "buttons", "list", "driveFile"]) {
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

test("each reply is logged to the CRM in the shape wa.js sends", async () => {
  const { channel, crmCalls, done } = make();
  await channel.text("u1", "hello");
  await channel.longText("u1", "long body");
  await channel.buttons("u1", "Pick", [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }]);
  await channel.list("u1", "List", "Choose", [{ id: "x", title: "Xray" }]);
  await channel.driveFile("u1", { id: "F1", name: "Spec.pdf", folder: "T", size: 1 });
  await channel.driveFile("u1", { id: "F2", name: "Photo.png", folder: "T", size: 1 });
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
