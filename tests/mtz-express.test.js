// The one-line MTZ command the menu advertises ("MTZ Selection 8.5TR 80/67/115"):
// the parser (pure), then the command through the real server.js and the real MTZ
// engine (replay harness; skipped when the private fixtures are not on this machine).
const test = require("node:test");
const assert = require("node:assert");
const { parseMtzExpress } = require("../lib/mtz-express.js");
const { createHarness, createServerDeliver, fixturesExist } = require("./replay/harness.js");

test("parseMtzExpress reads the shortcut", () => assert.deepEqual(
  parseMtzExpress("MTZ Selection 8.5TR 80/67/115"), { reqTC: 102, reqSC: null, db: 80, wb: 67, amb: 115 }));

test("it reads a sensible load", () => assert.equal(parseMtzExpress("MTZ Selection 8.5TR/7TR 80/67/115").reqSC, 84));

test("bare command and out-of-range values give null", () => {
  assert.equal(parseMtzExpress("MTZ Selection"), null);
  assert.equal(parseMtzExpress("MTZ Selection 8.5TR 200/67/115"), null);
});

test("the conditions are the last three numbers, however the load is written", () => {
  const want = { reqTC: 102, reqSC: null, db: 80, wb: 67, amb: 115 };
  assert.deepEqual(parseMtzExpress("mtz selection 8.5 TR 80/67/115"), want);
  assert.deepEqual(parseMtzExpress("  MTZ   SELECTION  8.5tr   80 67 115 "), want);
  assert.deepEqual(parseMtzExpress("MTZ Selection 8.5 TR 80, 67, 115"), want);
  assert.deepEqual(parseMtzExpress("MTZ Selection 102 MBH 80/67/115"), want);
  assert.deepEqual(parseMtzExpress("MTZ Selection 102 80/67/115"), want, "a bare load is MBH, as in the guided steps");
  assert.deepEqual(parseMtzExpress("MTZ Selection 8.5 tons 80/67/115"), want);
  assert.deepEqual(parseMtzExpress("MTZ Selection 8.5 TR / 7 TR 80/67/115"), { ...want, reqSC: 84 });
  assert.deepEqual(parseMtzExpress("MTZ Selection 8.5TR, 7TR 85.5/70/110"), { reqTC: 102, reqSC: 84, db: 85.5, wb: 70, amb: 110 });
});

test("1 TR is 12 MBH", () => assert.equal(parseMtzExpress("MTZ Selection 1TR 80/67/115").reqTC, 12));

test("each condition has its range, and wet bulb cannot pass dry bulb", () => {
  const ok = (c) => parseMtzExpress(`MTZ Selection 8.5TR ${c}`);
  assert.notEqual(ok("60/50/70"), null);
  assert.notEqual(ok("100/85/135"), null);
  for (const c of ["59/50/115", "101/67/115", "80/49/115", "80/86/115", "70/75/115", "80/67/69", "80/67/136", "0/0/0"]) {
    assert.equal(ok(c), null, c);
  }
});

test("anything that is not a clear command gives null", () => {
  for (const t of [
    "", "MTZ", "MTZ Selection 80/67/115", "MTZ Selection TR 80/67/115", "MTZ Selection 0TR 80/67/115",
    "MTZ Selection 8.5TR 80/67", "MTZ Selection 8.5TR 80/67/115 2800", "MTZ Selection hello",
    "MTZ Selection 100 kW 80/67/115", "MTZ Selection 8.5TR/7TR/3TR 80/67/115", null, undefined, 42,
  ]) assert.equal(parseMtzExpress(t), null, String(t));
});

test("a sensible load above the total is ignored, as in the guided steps", () => {
  assert.equal(parseMtzExpress("MTZ Selection 8.5TR/9TR 80/67/115").reqSC, null);
});

test("a command that is not about MTZ selection gives null", () => {
  assert.equal(parseMtzExpress("Split Selection 8.5TR 80/67/115"), null);
  assert.equal(parseMtzExpress("8.5TR 80/67/115"), null);
});

const skip = !fixturesExist() && "replay fixtures not found (run tests/replay/export-log.js)";
const USER = "100000001";

test("the advertised example starts the MTZ steps at the airflow question and then runs the engine", { skip }, async () => {
  const h = createHarness(createServerDeliver());
  try {
    const { MENU_OPTIONS } = require("../menu.js");
    const advertised = /`(MTZ Selection [^`]+)`/.exec(MENU_OPTIONS.map((o) => o.tip || "").join("\n"));
    assert.ok(advertised, "the menu advertises an example");
    assert.equal(advertised[1], "MTZ Selection 8.5TR 80/67/115");

    const first = await h.send(USER, advertised[1]);
    assert.equal(first.length, 1);
    assert.match(first[0].text, /102\.0 MBH/);
    assert.match(first[0].text, /DB80\/WB67°F · Amb 115°F/);
    assert.match(first[0].text, /Step 3\/3/);
    assert.doesNotMatch(first[0].text, /Step 1\/3/, "it did not fall back to the guided steps");

    const done = await h.send(USER, "2800 | Test Project | PAC-01");
    const text = done.filter((o) => o.kind === "text").map((o) => o.text).join("\n");
    assert.match(text, /Top Models @ DB80\/WB67°F, 115°F amb/);
    assert.match(text, /MTZ|\*[A-Z0-9-]+\*/);
    const file = done.find((o) => o.kind === "file");
    assert.ok(file, "the datasheet PDF is sent");
    assert.equal(file.file, "MTZ_Selection_PAC-01.pdf");
    assert.equal(h.stats.errors, 0);
  } finally { h.close(); }
});

test("the shortcut gives the same models as the three guided steps", { skip }, async () => {
  const h = createHarness(createServerDeliver());
  try {
    await h.send(USER, "MTZ Selection 8.5TR/7TR 80/67/115");
    const quick = await h.send(USER, "rated");
    await h.send(USER, "MTZ Selection");
    await h.send(USER, "8.5TR / 7TR");
    await h.send(USER, "80/67/115");
    const slow = await h.send(USER, "rated");
    const body = (out) => out.filter((o) => o.kind === "text").map((o) => o.text).join("\n");
    assert.match(body(quick), /Top Models/);
    assert.equal(body(quick), body(slow));
    assert.equal(quick.find((o) => o.kind === "file").file, slow.find((o) => o.kind === "file").file);
  } finally { h.close(); }
});

test("a malformed command falls back to the guided steps, as the bare command does", { skip }, async () => {
  const h = createHarness(createServerDeliver());
  try {
    const bare = await h.send(USER, "MTZ Selection");
    await h.send(USER, "cancel");
    for (const t of ["MTZ Selection 8.5TR 200/67/115", "MTZ Selection hello there", "MTZ Selection 8.5TR 80/67"]) {
      const out = await h.send(USER, t);
      assert.deepEqual(out, bare, t);
      await h.send(USER, "cancel");
    }
  } finally { h.close(); }
});

test("a comma between digits is never read as a separator or a decimal point", () => {
  for (const t of [
    "MTZ Selection 8,5TR 80/67/115", "MTZ Selection 8,5 TR 80/67/115", "MTZ Selection 1,000 MBH 80/67/115",
    "MTZ Selection 8.5TR 80,67,115",
  ]) assert.equal(parseMtzExpress(t), null, t);
  // a comma beside a space or a unit is still the total/sensible separator
  assert.equal(parseMtzExpress("MTZ Selection 8.5TR, 7TR 80/67/115").reqSC, 84);
  assert.equal(parseMtzExpress("MTZ Selection 8.5TR , 7TR 80/67/115").reqSC, 84);
  assert.equal(parseMtzExpress("MTZ Selection 8.5TR,7TR 80/67/115").reqSC, 84);
});
