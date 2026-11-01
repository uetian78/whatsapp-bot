const test = require("node:test");
const assert = require("node:assert");
const { openDb } = require("../lib/db.js");
const { createConversations } = require("../lib/conversations.js");

function make(extra = {}) {
  let t = 1000;
  const db = openDb(":memory:");
  const conversations = createConversations({ db, now: () => (t += 10), ...extra });
  return { db, conversations };
}

test("a fresh database gets the messages table", () => {
  const { db } = make();
  const cols = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
  assert.deepEqual(cols, ["seq", "user", "role", "kind", "body", "ts"]);
});

test("a fresh database gets the generated_files table", () => {
  const { db } = make();
  const cols = db.prepare("PRAGMA table_info(generated_files)").all().map((c) => c.name);
  assert.deepEqual(cols, ["id", "user", "name", "mime", "size", "created_at"]);
});

test("append returns an increasing integer seq", () => {
  const { conversations: c } = make();
  const a = c.append("u1", "user", "text", "hi");
  const b = c.append("u2", "bot", "text", "yo");
  assert.ok(Number.isInteger(a) && Number.isInteger(b));
  assert.ok(b > a);
});

test("since returns only that user's rows, after the given seq", () => {
  const { conversations: c } = make();
  const a = c.append("u1", "user", "text", "one");
  c.append("u2", "user", "text", "other user");
  const b = c.append("u1", "bot", "text", "two");
  const d = c.append("u1", "bot", "text", "three");
  assert.deepEqual(c.since("u1", 0).map((m) => m.body), ["one", "two", "three"]);
  assert.deepEqual(c.since("u1", a).map((m) => m.seq), [b, d]);
  assert.deepEqual(c.since("u1", d), []);
  assert.deepEqual(c.since("nobody", 0), []);
});

test("since respects the limit, oldest first", () => {
  const { conversations: c } = make();
  for (let i = 0; i < 5; i++) c.append("u1", "user", "text", `m${i}`);
  assert.deepEqual(c.since("u1", 0, 2).map((m) => m.body), ["m0", "m1"]);
});

test("a message has seq, role, kind, body and ts", () => {
  const { conversations: c } = make();
  const seq = c.append("u1", "user", "text", "hi");
  assert.deepEqual(c.since("u1", 0), [{ seq, role: "user", kind: "text", body: "hi", ts: 1010 }]);
});

test("non-text bodies come back as objects", () => {
  const { conversations: c } = make();
  const choices = { text: "Pick", choices: [{ id: "a", title: "A", description: "" }] };
  c.append("u1", "bot", "choices", choices);
  c.append("u1", "bot", "note", "a plain note");
  const [m1, m2] = c.since("u1", 0);
  assert.deepEqual(m1.body, choices);
  assert.equal(m2.body, "a plain note");
});

test("savedWork returns the newest file messages for that user only", () => {
  const { conversations: c } = make();
  c.append("u1", "bot", "file", { ref: "drive:a", name: "a.pdf" });
  c.append("u1", "bot", "text", "chatter");
  c.append("u2", "bot", "file", { ref: "drive:other", name: "other.pdf" });
  c.append("u1", "bot", "file", { ref: "gen:1", name: "b.xlsx" });
  c.append("u1", "bot", "file", { ref: "drive:c", name: "c.pdf" });
  const names = c.savedWork("u1").map((m) => m.body.name);
  assert.deepEqual(names, ["c.pdf", "b.xlsx", "a.pdf"]);
  assert.deepEqual(c.savedWork("u1", 2).map((m) => m.body.name), ["c.pdf", "b.xlsx"]);
});

test("isEmpty is true until the user has a message", () => {
  const { conversations: c } = make();
  assert.equal(c.isEmpty("u1"), true);
  c.append("u2", "user", "text", "hi");
  assert.equal(c.isEmpty("u1"), true);
  c.append("u1", "user", "text", "hi");
  assert.equal(c.isEmpty("u1"), false);
});
