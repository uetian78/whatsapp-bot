const test = require("node:test");
const assert = require("node:assert");
const { classify, INTENTS } = require("../intents.js");

test("intent order matches the webhook router order", () => {
  assert.deepEqual(INTENTS.map((i) => i.name), [
    "media", "button-tap", "numbered-reply", "menu",
    "admin-stats", "small-talk", "search-all", "ai-search",
    "list-units", "question", "chiller", "datasheet", "selection",
    "catalogue-iom", "model-code", "doc-search",
  ]);
});

test("classify routes representative messages like the router does", () => {
  assert.equal(classify("hi"), "menu");
  assert.equal(classify("thanks"), "small-talk");
  assert.equal(classify("list APMR units"), "list-units");
  assert.equal(classify("what is the capacity of APMR 52340?"), "question");
  assert.equal(classify("package unit 20 tr t3"), "selection");
  assert.equal(classify("APMR catalogue"), "catalogue-iom");
  // find/search is the request typed without the verb, as the router treats it
  assert.equal(classify("find APMR catalogue"), "catalogue-iom");
  assert.equal(classify("search please package unit 20 tr t3"), "selection");
  assert.equal(classify("find me the apmra 51004"), classify("apmra 51004"));
  assert.equal(classify("find APCY-H 30 tr"), "chiller");
  assert.equal(classify("search all"), "search-all");
  assert.equal(classify("find"), "other");
  assert.equal(classify("random gibberish xyz"), "other");
});

