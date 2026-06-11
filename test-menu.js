// Tests for the welcome menu + "how to ask" tips (menu.js).
// The important guard: every example phrasing embedded in a tip must still
// trigger its handler, so the menu never teaches a phrasing that fails.

const { isMenuTrigger, welcomeMenu, tipFor, MENU_OPTIONS } = require("./menu.js");
const p = require("./products.js");
const ch = require("./chillers.js");
const { findBrandDocs } = require("./brand-docs.js");

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log("  ✅", label); } else { fail++; console.log("  ❌", label); } };

console.log("isMenuTrigger");
ok('"hi" triggers', isMenuTrigger("hi"));
ok('"Menu" triggers', isMenuTrigger("Menu"));
ok('"help" triggers', isMenuTrigger("help"));
ok('"good morning" triggers', isMenuTrigger("good morning"));
ok('"start" triggers', isMenuTrigger("start"));
ok('real request is NOT a trigger', !isMenuTrigger("hi can I get the APMR catalogue"));
ok('product request is NOT a trigger', !isMenuTrigger("apmr catalogue"));
ok('empty is NOT a trigger', !isMenuTrigger("   "));

console.log("welcomeMenu");
const w = welcomeMenu();
ok("10 options", w.options.length === 10);
ok("text mentions VRF Selection", /VRF Selection/.test(w.text));
ok("text mentions Datasheets", /Datasheet/i.test(w.text));
ok("text mentions Chillers", /Chiller/i.test(w.text));

console.log("tipFor");
for (let n = 1; n <= 10; n++) ok(`tip ${n} exists`, !!tipFor(n));
ok("tip 11 is null", tipFor(11) === null);
ok("tip 0 is null", tipFor(0) === null);

console.log("every embedded example still triggers its handler");
// [phrasing, fn returning a truthy result when the handler matches]
const examples = [
  ["package unit 20 tr t3", () => p.buildSelectionInteractive("package unit 20 tr t3")],
  ["5000 cfm package unit", () => p.buildSelectionInteractive("5000 cfm package unit")],
  ["fresh air 15 tr", () => p.buildSelectionInteractive("fresh air 15 tr")],
  ["pac4a 10 tr", () => p.buildSelectionInteractive("pac4a 10 tr")],
  ["APMR catalogue", () => p.parseSeriesRequest("APMR catalogue")],
  ["APMR IOM", () => p.parseSeriesRequest("APMR IOM")],
  ["MAH catalogue", () => p.parseSeriesRequest("MAH catalogue")],
  ["APCY-H catalogue", () => p.parseSeriesRequest("APCY-H catalogue")],
  ["APMRa 51004", () => p.parseDatasheetRequest("APMRa 51004")],
  ["APMR 52340 T1", () => p.parseDatasheetRequest("APMR 52340 T1")],
  ["APCY-H 30 tr", () => ch.routeChillerText("APCY-H 30 tr")],
  ["APCY5530TH datasheet", () => ch.routeChillerText("APCY5530TH datasheet")],
  ["fcu", () => p.parseSeriesRequest("fcu")],
  ["DMP 10 tr", () => p.buildSelectionInteractive("DMP 10 tr")],
  ["Hisense catalogue", () => findBrandDocs("Hisense catalogue", null)],
  ["Hisense VRF", () => findBrandDocs("Hisense VRF", null)],
];
const tipBlob = MENU_OPTIONS.map((o) => o.tip).join("\n");
for (const [phrase, fn] of examples) {
  const r = fn();
  const triggers = !!(r && (Array.isArray(r) ? r.length : true));
  ok(`example triggers: "${phrase}"`, triggers);
  ok(`a tip actually shows: "${phrase}"`, tipBlob.includes(phrase));
}

console.log(`\n${fail === 0 ? "✅ All menu checks passed" : "❌ " + fail + " FAILED"} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
