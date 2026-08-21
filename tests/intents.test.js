const test = require("node:test");
const assert = require("node:assert");
const { classify, INTENTS } = require("../intents.js");

test("intent order matches the webhook router order", () => {
  assert.deepEqual(INTENTS.map((i) => i.name), [
    "media", "button-tap", "numbered-reply", "menu",
    "vrf-selection", "schedule-selection", "split-selection", "mtz-selection", "print",
    "admin-stats", "small-talk", "search-all",
    "split-list", "list-units", "question", "chiller", "datasheet", "selection",
    "catalogue-iom", "model-code", "doc-search",
  ]);
});

test("classify routes representative messages like the router does", () => {
  assert.equal(classify("hi"), "menu");
  assert.equal(classify("thanks"), "small-talk");
  assert.equal(classify("VRF Selection"), "vrf-selection");
  assert.equal(classify("Schedule Selection"), "schedule-selection");
  assert.equal(classify("Split Selection"), "split-selection");
  assert.equal(classify("MTZ Selection"), "mtz-selection");
  // Only the exact trigger phrase starts the mtz flow — bare "mtz" or
  // free-text mentioning mtz must NOT be hijacked (regression: #mtz-too-broad).
  assert.notEqual(classify("mtz"), "mtz-selection");
  assert.notEqual(classify("mtz load 8.5tr"), "mtz-selection");
  assert.equal(classify("print"), "print");
  assert.equal(classify("list of split units"), "split-list");
  assert.equal(classify("list APMR units"), "list-units");
  assert.equal(classify("what is the capacity of APMR 52340?"), "question");
  assert.equal(classify("package unit 20 tr t3"), "selection");
  assert.equal(classify("APMR catalogue"), "catalogue-iom");
  assert.equal(classify("random gibberish xyz"), "other");
});
