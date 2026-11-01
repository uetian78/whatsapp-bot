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

test("the menu offers document, quick selection, schedule, guided and question rows, and says HVAC Assistant", () => {
  const { welcomeMenuList } = require("../menu.js");
  assert.deepEqual(MENU_OPTIONS.map((o) => o.short), ["Documents", "Quick Selection", "Read a schedule", "Guided Selectors", "Ask a question", "Help"]);
  assert.deepEqual(MENU_OPTIONS.map((o) => o.n), [1, 2, 3, 4, 5, 6]);
  const list = welcomeMenuList("Hassan", false);
  assert.deepEqual(list.rows.map((r) => r.id), ["menu|1", "menu|2", "menu|3", "menu|4", "menu|5", "menu|6"]);
  for (const text of [welcomeMenu("Hassan", false).text, list.body]) {
    assert.match(text, /HVAC Assistant/);
    assert.doesNotMatch(text, /Mannai/);
  }
  for (const o of MENU_OPTIONS) {
    assert.doesNotMatch(`${o.title} ${o.short} ${o.desc} ${o.tip}`, /Mannai HVAC/);
    assert.ok(tipFor(o.n), `tip missing for option ${o.n}`);
  }
});

test("the Documents tip explains find sound level, and the schedule row starts the schedule flow", () => {
  assert.match(tipFor(1), /find sound level/);
  const schedule = MENU_OPTIONS.find((o) => o.short === "Read a schedule");
  assert.equal(schedule.action, "schedule");
  assert.equal(MENU_OPTIONS.filter((o) => o.action).length, 1);
});

test("the welcome text numbers every option, including 5 and 6", () => {
  const m = welcomeMenu("Hassan", false);
  for (let n = 1; n <= 6; n++) assert.ok(m.text.includes(`${["", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"][n]} `), `number ${n}`);
});
