const test = require("node:test");
const assert = require("node:assert");
const store = require("../lib/session-store.js");

test("flow lifecycle: start, get, touch, end", () => {
  store.startFlow("u1", "split", { step: "brand" }, 60_000);
  const f = store.getFlow("u1");
  assert.equal(f.type, "split");
  assert.equal(f.data.step, "brand");
  f.data.step = "condition"; // callers mutate data in place, like today
  assert.equal(store.getFlow("u1").data.step, "condition");
  store.endFlow("u1");
  assert.equal(store.getFlow("u1"), null);
});

test("starting a flow replaces the previous one", () => {
  store.startFlow("u2", "split", {}, 60_000);
  store.startFlow("u2", "mtz", { step: "load" }, 60_000);
  assert.equal(store.getFlow("u2").type, "mtz");
});

test("expired flow reports { expired, type } exactly once", () => {
  store.startFlow("u3", "schedule", {}, -1); // already expired
  const f = store.getFlow("u3");
  assert.deepEqual(f, { expired: true, type: "schedule" });
  assert.equal(store.getFlow("u3"), null); // reported once, then gone
});

test("ctx: independent keys, silent expiry", () => {
  store.setCtx("u4", "menu", { options: [1, 2] }, 60_000);
  store.setCtx("u4", "list", ["a.pdf"], -1); // already expired
  assert.deepEqual(store.getCtx("u4", "menu"), { options: [1, 2] });
  assert.equal(store.getCtx("u4", "list"), null);
});

test("clearAll wipes flow and ctx", () => {
  store.startFlow("u5", "split", {}, 60_000);
  store.setCtx("u5", "menu", {}, 60_000);
  store.clearAll("u5");
  assert.equal(store.getFlow("u5"), null);
  assert.equal(store.getCtx("u5", "menu"), null);
});
