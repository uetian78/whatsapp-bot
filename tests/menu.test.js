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

test("welcomeMenuList builds API-safe rows for every option", () => {
  const { welcomeMenuList } = require("../menu.js");
  const m = welcomeMenuList("Hassan", false);
  assert.equal(m.rows.length, MENU_OPTIONS.length);
  for (const r of m.rows) {
    assert.match(r.id, /^menu\|\d+$/);
    assert.ok(r.title.length > 0 && r.title.length <= 24, `title too long: ${r.title}`);
    assert.ok(!r.description || r.description.length <= 72);
  }
  assert.ok(m.buttonLabel.length <= 20);
  assert.match(m.body, /Welcome, Hassan/);
});

test("the menu offers Documents, Chiller and package selection, and Help, and says HVAC Assistant", () => {
  const { welcomeMenuList } = require("../menu.js");
  assert.deepEqual(MENU_OPTIONS.map((o) => o.short), ["Documents", "Chiller and package", "Help"]);
  assert.deepEqual(MENU_OPTIONS.map((o) => o.n), [1, 2, 3]);
  const list = welcomeMenuList("Hassan", false);
  assert.deepEqual(list.rows.map((r) => r.id), ["menu|1", "menu|2", "menu|6"]);
  for (const text of [welcomeMenu("Hassan", false).text, list.body]) {
    assert.match(text, /HVAC Assistant/);
    assert.doesNotMatch(text, /Mannai/);
  }
  for (const o of MENU_OPTIONS) {
    assert.doesNotMatch(`${o.title} ${o.short} ${o.desc} ${o.tip}`, /Mannai HVAC/);
    assert.ok(tipFor(o.n), `tip missing for option ${o.n}`);
  }
});

test("nothing the menu says advertises a removed feature", () => {
  const { welcomeMenuList, MENU_HINT } = require("../menu.js");
  const everything = [
    welcomeMenu("Hassan", true).text, welcomeMenuList("Hassan", false).body, MENU_HINT,
    smallTalkReply("thanks"), smallTalkReply("bye"), smallTalkReply("ok"),
    ...MENU_OPTIONS.map((o) => `${o.title} ${o.short} ${o.desc} ${o.tip}`),
  ].join("\n");
  for (const word of [/VRF/i, /split/i, /MTZ/i, /schedule/i, /BOQ/i, /guided/i, /ask a question/i, /inside the PDFs/i, /find sound level/i, /\bPrint\b/]) {
    assert.doesNotMatch(everything, word, String(word));
  }
});

test("the Help tip says the assistant finds documents and does not answer written spec questions", () => {
  const help = MENU_OPTIONS.find((o) => o.short === "Help").tip;
  assert.match(help, /find/i);
  assert.match(help, /don't answer|do not answer|can't answer/i);
});

test("an old row id never opens a different tip: only the ids of the three rows open one", () => {
  const { optionForTap } = require("../menu.js");
  assert.equal(optionForTap("menu|1").short, "Documents");
  assert.equal(optionForTap("menu|2").short, "Chiller and package");
  assert.equal(optionForTap("menu|6").short, "Help");
  for (const id of ["menu|3", "menu|4", "menu|5", "menu|7", "menu|9", "menu|", "menu|x", "other"]) assert.equal(optionForTap(id), null, id);
});

test("every example the Documents and selection tips advertise is a request the app understands", () => {
  const { classify } = require("../intents.js");
  const examples = [];
  for (const o of MENU_OPTIONS.filter((o) => o.short !== "Help")) {
    for (const m of o.tip.matchAll(/\*([^*\n]+)\*/g)) examples.push(m[1]);
  }
  const typed = examples.filter((e) => /\d|catalogue|IOM|find |search |fcu/i.test(e));
  assert.ok(typed.length >= 8, "the tips carry examples");
  for (const e of typed) {
    for (const variant of e.split(/\s+or\s+/i)) {
      const { stripFindVerb } = require("../lib/broad-search.js");
      const rest = stripFindVerb(variant.trim());
      if (rest) { // "find X" is X typed without the verb
        assert.equal(classify(variant.trim()), classify(rest), variant);
        continue;
      }
      const kind = classify(variant.trim());
      assert.ok(!["other", "empty", "question"].includes(kind), `"${variant}" classifies as ${kind}`);
    }
  }
});

test("the welcome text numbers every option", () => {
  const m = welcomeMenu("Hassan", false);
  for (let n = 1; n <= MENU_OPTIONS.length; n++) assert.ok(m.text.includes(`${["", "1️⃣", "2️⃣", "3️⃣"][n]} `), `number ${n}`);
});
