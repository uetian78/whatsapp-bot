const test = require("node:test");
const assert = require("node:assert");
const { classify, INTENTS } = require("../intents.js");

test("intent order matches the webhook router order", () => {
  assert.deepEqual(INTENTS.map((i) => i.name), [
    "media", "button-tap", "numbered-reply", "menu", "small-talk", "admin-stats",
    "vrf-selection", "schedule-selection", "split-selection", "mtz-selection", "print",
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
  assert.equal(classify("print"), "print");
  assert.equal(classify("list of split units"), "split-list");
  assert.equal(classify("list APMR units"), "list-units");
  assert.equal(classify("what is the capacity of APMR 52340?"), "question");
  assert.equal(classify("package unit 20 tr t3"), "selection");
  assert.equal(classify("APMR catalogue"), "catalogue-iom");
  assert.equal(classify("random gibberish xyz"), "other");
});
