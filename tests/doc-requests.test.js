const test = require("node:test");
const assert = require("node:assert");
const dr = require("../lib/doc-requests.js");

test("request button and list row fit WhatsApp's title limits", () => {
  assert.equal(dr.REQUEST_BUTTON.id, "docreq");
  assert.ok(dr.REQUEST_BUTTON.title.length <= 20);
  assert.equal(dr.REQUEST_ROW.id, "docreq");
  assert.ok(dr.REQUEST_ROW.title.length <= 24);
  assert.ok(dr.REQUEST_ROW.description.length <= 72);
});

test("request wording makes no time promise", () => {
  assert.equal(dr.REQUEST_BUTTON.title, "📥 Request it");
  const all = [dr.REQUEST_PROMPT, dr.REQUEST_BUTTON.title, dr.REQUEST_ROW.title, dr.REQUEST_ROW.description,
    dr.confirmText("x"), dr.duplicateText("x")];
  for (const s of all) assert.doesNotMatch(s, /minute|mins?|within|instant/i, s);
});

test("request copy is the agreed wording", () => {
  assert.equal(dr.REQUEST_PROMPT, "📥 Can't find it? Tap *Request it* and we'll add it to the library.");
  assert.equal(dr.confirmText("APMR IOM"),
    "✅ Request sent for *\"APMR IOM\"*. We'll add it to the library as soon as we can.");
  assert.equal(dr.REQUEST_ROW.title, "📥 Request it");
});

test("alertNumbers: defaults to the admin number, digits only", () => {
  assert.deepEqual(dr.alertNumbers({}), ["97466279059"]);
  assert.deepEqual(dr.alertNumbers({ ADMIN_NUMBERS: "" }), ["97466279059"]);
});

test("alertNumbers: ADMIN_NUMBERS overrides, normalized and de-duplicated", () => {
  assert.deepEqual(
    dr.alertNumbers({ ADMIN_NUMBERS: "+974 6627 9059, 97455555555,97466279059" }),
    ["97466279059", "97455555555"]
  );
});

test("requestRow: time, number, name, query, Open", () => {
  assert.deepEqual(
    dr.requestRow({ ts: "2026-09-21 10:00:00", from: "9745", name: "Ali", query: "APMR IOM" }),
    ["2026-09-21 10:00:00", "9745", "Ali", "APMR IOM", "Open"]
  );
  // Missing name -> blank cell, and long queries are capped.
  const row = dr.requestRow({ ts: "t", from: "1", query: "x".repeat(500) });
  assert.equal(row[2], "");
  assert.equal(row[3].length, 300);
});

test("dedupe: same number + same query (case/space-insensitive) within 24h", () => {
  let now = 1_000_000;
  const d = dr.createDedupe(() => now);
  assert.equal(d.seen("9745", "APMR IOM"), false); // first time -> record
  assert.equal(d.seen("9745", "  apmr   iom "), true);
  assert.equal(d.seen("9746", "APMR IOM"), false); // other user
  assert.equal(d.seen("9745", "ACMR IOM"), false); // other query
  now += dr.DEDUPE_MS + 1;
  assert.equal(d.seen("9745", "APMR IOM"), false); // window passed
});

test("admin alert and user confirmation carry the query", () => {
  const a = dr.adminAlertText({ from: "9745", name: "Ali", query: "APMR IOM" });
  assert.match(a, /Ali/);
  assert.match(a, /9745/);
  assert.match(a, /APMR IOM/);
  assert.match(dr.confirmText("APMR IOM"), /APMR IOM/);
  assert.match(dr.duplicateText("APMR IOM"), /already/i);
});

test("isAdmin uses ADMIN_NUMBERS, else the default admin; others are refused", () => {
  assert.equal(dr.isAdmin("97411111111", { ADMIN_NUMBERS: "97411111111" }), true);
  assert.equal(dr.isAdmin("97466279059", {}), true);
  assert.equal(dr.isAdmin("97422222222", {}), false);
});

test("isAdmin: digits-only match and a set ADMIN_NUMBERS replaces the default", () => {
  const env = { ADMIN_NUMBERS: "+974 1111 1111, 97433333333" };
  assert.equal(dr.isAdmin("+97411111111", env), true);
  assert.equal(dr.isAdmin("97433333333", env), true);
  assert.equal(dr.isAdmin("97466279059", env), false);
  assert.equal(dr.isAdmin("", {}), false);
  assert.equal(dr.isAdmin(undefined, {}), false);
});
