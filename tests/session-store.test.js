const test = require("node:test");
const assert = require("node:assert");
const store = require("../lib/session-store.js");

test("flow lifecycle: start, get, touch, end", () => {
  store.startFlow("u1", "alpha", { step: "brand" }, 60_000);
  const f = store.getFlow("u1");
  assert.equal(f.type, "alpha");
  assert.equal(f.data.step, "brand");
  f.data.step = "condition"; // callers mutate data in place, like today
  assert.equal(store.getFlow("u1").data.step, "condition");
  store.endFlow("u1");
  assert.equal(store.getFlow("u1"), null);
});

test("starting a flow replaces the previous one", () => {
  store.startFlow("u2", "alpha", {}, 60_000);
  store.startFlow("u2", "beta", { step: "load" }, 60_000);
  assert.equal(store.getFlow("u2").type, "beta");
});

test("expired flow reports { expired, type } exactly once", () => {
  store.startFlow("u3", "gamma", {}, -1); // already expired
  const f = store.getFlow("u3");
  assert.deepEqual(f, { expired: true, type: "gamma" });
  assert.equal(store.getFlow("u3"), null); // reported once, then gone
});

test("ctx: independent keys, silent expiry", () => {
  store.setCtx("u4", "menu", { options: [1, 2] }, 60_000);
  store.setCtx("u4", "list", ["a.pdf"], -1); // already expired
  assert.deepEqual(store.getCtx("u4", "menu"), { options: [1, 2] });
  assert.equal(store.getCtx("u4", "list"), null);
});

test("clearAll wipes flow and ctx", () => {
  store.startFlow("u5", "alpha", {}, 60_000);
  store.setCtx("u5", "menu", {}, 60_000);
  store.clearAll("u5");
  assert.equal(store.getFlow("u5"), null);
  assert.equal(store.getCtx("u5", "menu"), null);
});

// ── persistence: the Maps stay the working copy, SQLite survives restarts ──
const { openDb } = require("../lib/db.js");
const { createSessionStore } = store;

const rows = (db, user) => db.prepare("SELECT key, expires_at FROM user_state WHERE user = ? ORDER BY key").all(user);

test("a flow and its later edits survive a restart", () => {
  const db = openDb(":memory:");
  const a = createSessionStore({ db });
  const s = a.startFlow("u", "alpha", { step: "brand" });
  s.step = "condition"; // handlers mutate in place; persist writes the current state
  a.persist("u");
  const b = createSessionStore({ db });
  b.restore();
  assert.equal(b.getFlow("u").type, "alpha");
  assert.equal(b.getFlow("u").data.step, "condition");
});

test("after a restart an expired ctx is gone, but an expired flow still reports that it timed out, once", () => {
  const db = openDb(":memory:");
  let t = 1_000;
  const a = createSessionStore({ db, now: () => t });
  a.startFlow("u", "alpha", { step: "x" }, 100);
  a.setCtx("u", "menu", { o: 1 }, 100);
  a.setCtx("u", "list", ["a"], 10_000);
  a.persist("u");
  assert.equal(rows(db, "u").length, 3);
  t = 5_000; // flow and menu are past their ttl, list is not
  const b = createSessionStore({ db, now: () => t });
  b.restore();
  assert.equal(b.getCtx("u", "menu"), null, "an expired ctx is not brought back");
  assert.deepEqual(b.getCtx("u", "list"), ["a"]);
  assert.deepEqual(rows(db, "u").map((r) => r.key), ["ctx:list", "flow"], "the ctx row is deleted; the flow row waits to be reported");
  assert.deepEqual(b.getFlow("u"), { expired: true, type: "alpha" });
  assert.equal(b.getFlow("u"), null, "reported once");
  b.persist("u"); // the end of the message that reported it
  assert.deepEqual(rows(db, "u").map((r) => r.key), ["ctx:list"], "and then its row is gone");
  const c = createSessionStore({ db, now: () => t });
  c.restore();
  assert.equal(c.getFlow("u"), null, "a later restart doesn't report it again");
});

test("an expired flow that nobody came back to is dropped after 24 hours", () => {
  const db = openDb(":memory:");
  const DAY = 24 * 60 * 60 * 1000;
  let t = 1_000;
  const a = createSessionStore({ db, now: () => t });
  a.startFlow("fresh", "beta", {}, 100);
  a.startFlow("old", "alpha", {}, 100);
  a.persist("fresh"); a.persist("old");
  t = 1_000 + 100 + DAY - 1; // just inside the day
  const b = createSessionStore({ db, now: () => t });
  b.restore();
  assert.equal(b.getFlow("fresh").expired, true);
  t = 1_000 + 100 + DAY + 1; // just past it
  const c = createSessionStore({ db, now: () => t });
  c.restore();
  assert.equal(c.getFlow("old"), null, "months-old sessions don't report");
  assert.deepEqual(rows(db, "old"), []);
});

test("persist keeps an expired flow for the day too, and the sweep leaves it to be reported", () => {
  const db = openDb(":memory:");
  let t = 1_000;
  const a = createSessionStore({ db, now: () => t });
  a.startFlow("u", "gamma", { step: "awaitImage" }, 100);
  t = 2_000; // expired, not yet reported
  a.persist("u");
  assert.deepEqual(rows(db, "u").map((r) => r.key), ["flow"]);
  a.sweep();
  assert.deepEqual(a.getFlow("u"), { expired: true, type: "gamma" });
  assert.equal(a.getFlow("u"), null);
});

test("expires_at comes from each entry's own ts + ttl", () => {
  const db = openDb(":memory:");
  const a = createSessionStore({ db, now: () => 2_000 });
  a.startFlow("u", "beta", {}, 500);
  a.setCtx("u", "menu", {}, 1_500);
  a.persist("u");
  const got = Object.fromEntries(rows(db, "u").map((r) => [r.key, r.expires_at]));
  assert.deepEqual(got, { flow: 2_500, "ctx:menu": 3_500 });
});

test("ctx values round-trip as JSON", () => {
  const db = openDb(":memory:");
  const a = createSessionStore({ db });
  const val = { options: [1, "two", { three: null }], n: 4.5, ok: true, nested: { a: [[]] } };
  a.setCtx("u", "menu", val);
  a.setCtx("u", "list", ["a.pdf", "b.pdf"]);
  a.persist("u");
  const b = createSessionStore({ db });
  b.restore();
  assert.deepEqual(b.getCtx("u", "menu"), val);
  assert.deepEqual(b.getCtx("u", "list"), ["a.pdf", "b.pdf"]);
});

test("persist replaces the user's rows: ended flows and cleared ctx do not come back", () => {
  const db = openDb(":memory:");
  const a = createSessionStore({ db });
  a.startFlow("u", "alpha", {});
  a.setCtx("u", "menu", {});
  a.persist("u");
  a.endFlow("u");
  a.clearCtx("u", "menu");
  a.persist("u");
  assert.deepEqual(rows(db, "u"), []);
  const b = createSessionStore({ db });
  b.restore();
  assert.equal(b.getFlow("u"), null);
});

test("persist only touches the named user", () => {
  const db = openDb(":memory:");
  const a = createSessionStore({ db });
  a.startFlow("u1", "alpha", {});
  a.startFlow("u2", "beta", {});
  a.persist("u1");
  a.persist("u2");
  a.endFlow("u1");
  a.persist("u1");
  assert.deepEqual(rows(db, "u1"), []);
  assert.deepEqual(rows(db, "u2").map((r) => r.key), ["flow"]);
});

test("a value that cannot be serialized is skipped with a warning, the rest is kept", () => {
  const db = openDb(":memory:");
  const a = createSessionStore({ db });
  a.startFlow("u", "alpha", { step: "x" });
  a.setCtx("u", "bad-buffer", { pdf: Buffer.from("SECRET-DOC-TEXT") });
  a.setCtx("u", "bad-fn", { cb: () => 1 });
  const cyc = {}; cyc.self = cyc;
  a.setCtx("u", "bad-cycle", cyc);
  a.setCtx("u", "good", { fine: 1 });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try { a.persist("u"); } finally { console.warn = realWarn; }
  assert.deepEqual(rows(db, "u").map((r) => r.key), ["ctx:good", "flow"]);
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((w) => w.includes("bad-buffer") && w.includes("Buffer")));
  assert.ok(warnings.some((w) => w.includes("bad-fn") && w.includes("function")));
  assert.ok(!warnings.join(" ").includes("SECRET-DOC-TEXT")); // keys and types only
  const b = createSessionStore({ db });
  b.restore();
  assert.equal(b.getFlow("u").data.step, "x");
  assert.deepEqual(b.getCtx("u", "good"), { fine: 1 });
  assert.equal(b.getCtx("u", "bad-buffer"), null);
});

test("a corrupt row is dropped on restore without stopping the others", () => {
  const db = openDb(":memory:");
  const a = createSessionStore({ db });
  a.startFlow("u", "alpha", { step: "x" });
  a.persist("u");
  db.prepare("INSERT INTO user_state (user, key, value, expires_at) VALUES ('u', 'ctx:junk', '{not json', ?)").run(Date.now() + 60_000);
  const b = createSessionStore({ db });
  b.restore();
  assert.equal(b.getFlow("u").data.step, "x");
  assert.deepEqual(rows(db, "u").map((r) => r.key), ["flow"]);
});

test("the store's clock is injected, and the default follows Date.now at call time", () => {
  const db = openDb(":memory:");
  let t = 10_000;
  const a = createSessionStore({ db, now: () => t });
  a.startFlow("u", "alpha", {}, 1_000);
  t = 10_999;
  assert.ok(a.getFlow("u").type);
  t = 11_001;
  assert.deepEqual(a.getFlow("u"), { expired: true, type: "alpha" });

  const realNow = Date.now;
  let frozen = 50_000;
  Date.now = () => frozen; // the replay harness freezes the clock like this
  try {
    const d = createSessionStore({ db });
    d.startFlow("v", "alpha", {}, 1_000);
    frozen = 50_500;
    assert.ok(d.getFlow("v").type);
    frozen = 51_001;
    assert.equal(d.getFlow("v").expired, true);
  } finally { Date.now = realNow; }
});

// ── flows and saved results from features that no longer exist ──
// A person who was in the middle of one when the app was updated has the row in
// user_state. It must not come back: nothing would know what to do with it.
test("a saved flow of a removed feature is dropped on restore, without an error", () => {
  const db = openDb(":memory:");
  const a = createSessionStore({ db });
  const save = (user, type, data) => { a.startFlow(user, type, data); a.persist(user); };
  save("s", "schedule", { step: "awaitCondition" });
  save("p", "split", { step: "capacities", brand: "TCL" });
  save("m", "mtz", { step: "extras" });
  save("k", "alpha", { step: "x" }); // not a removed one
  const b = createSessionStore({ db });
  assert.doesNotThrow(() => b.restore());
  for (const user of ["s", "p", "m"]) {
    assert.equal(b.getFlow(user), null, user);
    assert.deepEqual(rows(db, user), [], `${user}: the saved row is gone`);
  }
  assert.equal(b.getFlow("k").type, "alpha", "other flows are untouched");
});

test("an expired saved flow of a removed feature does not report a timeout after the update", () => {
  const db = openDb(":memory:");
  let t = 1_000;
  const a = createSessionStore({ db, now: () => t });
  a.startFlow("u", "schedule", {}, 100);
  t = 2_000; // expired, but still inside the day it is kept for
  a.persist("u");
  const b = createSessionStore({ db, now: () => t });
  b.restore();
  assert.equal(b.getFlow("u"), null);
});

test("saved results of removed features are dropped on restore; other saved state stays", () => {
  const db = openDb(":memory:");
  const a = createSessionStore({ db });
  a.setCtx("u", "splitResult", { brand: "TCL", units: [], at: 1 }, 60_000);
  a.setCtx("u", "scheduleResult", { rows: [], at: 2 }, 60_000);
  a.setCtx("u", "unitList", { kind: "product", keys: ["apmr"], system: "imp" }, 60_000);
  a.setCtx("u", "lastquery", "apmr catalogue", 60_000);
  a.persist("u");
  const b = createSessionStore({ db });
  b.restore();
  assert.equal(b.getCtx("u", "splitResult"), null);
  assert.equal(b.getCtx("u", "scheduleResult"), null);
  assert.deepEqual(b.getCtx("u", "unitList"), { kind: "product", keys: ["apmr"], system: "imp" });
  assert.equal(b.getCtx("u", "lastquery"), "apmr catalogue");
  assert.deepEqual(rows(db, "u").map((r) => r.key), ["ctx:lastquery", "ctx:unitList"]);
});

test("a saved unit list of the removed split kind is dropped on restore", () => {
  const db = openDb(":memory:");
  const a = createSessionStore({ db });
  a.setCtx("u", "unitList", { kind: "split", keys: ["PKV"], system: "si" }, 60_000);
  a.persist("u");
  const b = createSessionStore({ db });
  b.restore();
  assert.equal(b.getCtx("u", "unitList"), null);
});
