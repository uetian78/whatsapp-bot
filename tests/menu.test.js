const test = require("node:test");
const assert = require("node:assert");
const { isMenuTrigger, smallTalkReply, welcomeMenu, tipFor, MENU_OPTIONS } = require("../menu.js");

test("isMenuTrigger matches whole-message greetings only", () => {
  assert.equal(isMenuTrigger("hi"), true);
  assert.equal(isMenuTrigger("Menu"), true);
  assert.equal(isMenuTrigger("good morning"), true);
  assert.equal(isMenuTrigger("salam"), true);
  assert.equal(isMenuTrigger("hi can I get the APMR catalogue"), false);
  assert.equal(isMenuTrigger("catalogue"), false);
});

test("smallTalkReply catches closings but not requests", () => {
  assert.ok(smallTalkReply("thanks"));
  assert.ok(smallTalkReply("bye"));
  assert.ok(smallTalkReply("ok"));
  assert.equal(smallTalkReply("thanks, now send the APMR IOM"), null);
});

test("welcomeMenu lists every option and tipFor resolves each", () => {
  const m = welcomeMenu("Hassan", true);
  assert.match(m.text, /Welcome back, Hassan/);
  for (const o of MENU_OPTIONS) {
    assert.match(m.text, new RegExp(o.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(tipFor(o.n), `tip missing for option ${o.n}`);
  }
  assert.equal(tipFor(99), null);
});
