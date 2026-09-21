const test = require("node:test");
const assert = require("node:assert");
const { createStatusStore } = require("../lib/sender-status.js");

test("tracked id starts pending", () => {
  const s = createStatusStore();
  s.track("wamid.1");
  assert.equal(s.get("wamid.1").status, "pending");
});

test("untracked ids are ignored (bot's own replies also produce statuses)", () => {
  const s = createStatusStore();
  s.record({ id: "wamid.other", status: "delivered" });
  assert.equal(s.get("wamid.other"), null);
});

test("status only moves forward: sent -> delivered -> read", () => {
  const s = createStatusStore();
  s.track("w");
  s.record({ id: "w", status: "delivered" });
  s.record({ id: "w", status: "sent" }); // late, out-of-order event
  assert.equal(s.get("w").status, "delivered");
  s.record({ id: "w", status: "read" });
  assert.equal(s.get("w").status, "read");
});

test("failed 131047 is flagged outsideWindow and is terminal", () => {
  const s = createStatusStore();
  s.track("w");
  s.record({
    id: "w", status: "failed",
    errors: [{ code: 131047, title: "Re-engagement message", error_data: { details: "More than 24 hours have passed" } }],
  });
  s.record({ id: "w", status: "delivered" });
  const got = s.get("w");
  assert.equal(got.status, "failed");
  assert.equal(got.code, 131047);
  assert.equal(got.outsideWindow, true);
  assert.equal(got.message, "More than 24 hours have passed");
});

test("other failures are not outsideWindow", () => {
  const s = createStatusStore();
  s.track("w");
  s.record({ id: "w", status: "failed", errors: [{ code: 131026, title: "Message undeliverable" }] });
  assert.equal(s.get("w").outsideWindow, false);
  assert.equal(s.get("w").message, "Message undeliverable");
});

test("entries expire after one hour", () => {
  let t = 0;
  const s = createStatusStore({ now: () => t });
  s.track("w");
  t = 60 * 60 * 1000 + 1;
  assert.equal(s.get("w"), null);
});

test("bad input never throws", () => {
  const s = createStatusStore();
  s.record(null);
  s.record({});
  s.track(undefined);
  assert.equal(s.get(undefined), null);
});
