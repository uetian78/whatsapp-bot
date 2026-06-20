const assert = require("node:assert");
const S = require("./schedule-select.js");

// --- classifyCategory ---
assert.strictEqual(S.classifyCategory("PACKAGE AC"), "package");
assert.strictEqual(S.classifyCategory("Floor Stand"), "package");
assert.strictEqual(S.classifyCategory("Ducted split"), "ducted");
assert.strictEqual(S.classifyCategory("SPLIT"), "split");
assert.strictEqual(S.classifyCategory("Hi-Wall"), "split");
assert.strictEqual(S.classifyCategory("wall mounted"), "split");
assert.strictEqual(S.classifyCategory("mystery"), null);

// --- toKw / toTr / toMbh ---
assert.ok(Math.abs(S.toKw(48000, "BTU/HR") - 14.07) < 0.05);
assert.ok(Math.abs(S.toKw(4, "TR") - 14.07) < 0.05);
assert.ok(Math.abs(S.toKw(14.07, "kW") - 14.07) < 0.01);
assert.ok(Math.abs(S.toTr(14.07) - 4.0) < 0.02);
assert.ok(Math.abs(S.toMbh(14.07) - 48.0) < 0.2);

// --- splitFamilyKey ---
assert.strictEqual(S.splitFamilyKey("toshiba", "split"), "PKV");
assert.strictEqual(S.splitFamilyKey("toshiba", "ducted"), "BSP");
assert.strictEqual(S.splitFamilyKey("skm", "ducted"), "SKM-DCT");
assert.strictEqual(S.splitFamilyKey("tcl", "ducted"), null); // unsupported

// --- matchSplit: returns the smallest adequate model, with margin ---
const sm = S.matchSplit(5.0, "PKV", "T3");
assert.ok(sm && typeof sm.label === "string");
assert.ok(sm.capKw > 0);
assert.strictEqual(typeof sm.adequate, "boolean");

// --- matchPackageSkm: 14.1 kW T3 -> first APMR >= load (51060, 15.4) ---
const pk = S.matchPackageSkm(14.1, "apmr", "T3");
assert.strictEqual(pk.series, "apmr");
assert.strictEqual(pk.code, "51060");
assert.strictEqual(pk.adequate, true);
assert.strictEqual(pk.fellBack, false);

// --- fallback: 120 kW exceeds APMR max (87.6) -> APMR-A ---
const fb = S.matchPackageSkm(120, "apmr", "T3");
assert.strictEqual(fb.series, "apmr-a");
assert.strictEqual(fb.fellBack, true);
assert.strictEqual(fb.adequate, true);

// --- direct APMR-A request, no fallback flag ---
const aa = S.matchPackageSkm(14.0, "apmr-a", "T3");
assert.strictEqual(aa.series, "apmr-a");
assert.strictEqual(aa.fellBack, false);

// --- beyond APMR-A max (282.2): undersized largest model ---
const huge = S.matchPackageSkm(400, "apmr", "T3");
assert.strictEqual(huge.adequate, false);
assert.strictEqual(huge.series, "apmr-a");
assert.ok(Math.abs(huge.capKw - 282.2) < 0.1);

// --- Trane ---
const tr = S.matchPackageTrane(30, "T3");
assert.ok(tr && typeof tr.key === "string");
assert.ok(tr.tcMbh > 0);
assert.strictEqual(typeof tr.adequate, "boolean");
assert.ok(tr.tons > 0);
const over = S.matchPackageTrane(10000, "T3");
assert.strictEqual(over.adequate, false);

// --- buildExtractionPrompt mentions the JSON contract ---
const prompt = S.buildExtractionPrompt();
assert.match(prompt, /JSON array/i);
assert.match(prompt, /category/);

// --- normalizeRows: classify, convert, carry qty + raw; skip unreadable ---
const raw = [
  { location: "Main Hall", type: "PACKAGE AC", capacity: 48000, unit: "BTU/HR", qty: 8 },
  { location: "Ladies", type: "SPLIT", capacity: 3, unit: "TR", qty: 2 },
  { location: "Store", type: "SPLIT", capacity: "", unit: "", qty: 1 }, // unreadable
];
const { rows, skipped } = S.normalizeRows(raw);
assert.strictEqual(rows.length, 2);
assert.strictEqual(skipped.length, 1);
assert.strictEqual(rows[0].category, "package");
assert.ok(Math.abs(rows[0].requiredKw - 14.07) < 0.1);
assert.strictEqual(rows[0].qty, 8);
assert.strictEqual(rows[1].category, "split");
assert.ok(Math.abs(rows[1].requiredKw - 10.55) < 0.1);

// --- summarize flags which questions are needed ---
const sumRows = S.normalizeRows([
  { location: "Hall", type: "PACKAGE AC", capacity: 48000, unit: "BTU/HR", qty: 1 },
  { location: "Office", type: "SPLIT", capacity: 18000, unit: "BTU/HR", qty: 1 },
]).rows;
const sum = S.summarize(sumRows);
assert.strictEqual(sum.hasPackage, true);
assert.strictEqual(sum.hasSplit, true);

// --- buildReply renders a row per category + the verify list ---
const reply = S.buildReply(sumRows, [], {
  cond: "T3", splitBrand: "toshiba", pkgVendor: "skm", pkgSeries: "apmr",
});
assert.match(reply, /PACKAGE/);
assert.match(reply, /SPLIT/);
assert.match(reply, /APMR/);
assert.match(reply, /T3/);

// --- rowsFromScheduleImage exists and is async ---
assert.strictEqual(typeof S.rowsFromScheduleImage, "function");
assert.strictEqual(S.rowsFromScheduleImage.constructor.name, "AsyncFunction");

console.log("Task 6 OK");

// --- Task 1: parseCondition maps token + ambient ---
assert.strictEqual(S.parseCondition("T3", null), "T3");
assert.strictEqual(S.parseCondition("t1", null), "T1");
assert.strictEqual(S.parseCondition("", 46), "T3");
assert.strictEqual(S.parseCondition("", 35), "T1");
assert.strictEqual(S.parseCondition("", 22), null);
assert.strictEqual(S.parseCondition("", null), null);

// --- Task 1: lsToCfm ---
assert.ok(Math.abs(S.lsToCfm(100) - 211.888) < 0.01);

// --- Task 1: normalizeRows carries new optional fields ---
const t1rows = S.normalizeRows([
  { location: "AHU-1", type: "PACKAGE AC", capacity: 12, unit: "TR", qty: 1,
    condition: "T3", onCoilDb: 27, onCoilWb: 19, airflow: 4500, airflowUnit: "CFM" },
  { location: "Office", type: "SPLIT", capacity: 18000, unit: "BTU/HR", qty: 1,
    ambientC: 35, onCoilDb: 27, onCoilWb: 19 },
  { location: "Store", type: "SPLIT", capacity: 12000, unit: "BTU/HR", qty: 1 },
]).rows;
assert.strictEqual(t1rows[0].condition, "T3");
assert.strictEqual(t1rows[0].onCoilDb, 27);
assert.strictEqual(t1rows[0].onCoilWb, 19);
assert.strictEqual(t1rows[0].airflow, 4500);
assert.strictEqual(t1rows[1].condition, "T1");      // from ambientC 35
assert.strictEqual(t1rows[2].condition, null);      // nothing printed
assert.strictEqual(t1rows[2].onCoilDb, null);       // absent → null, row kept
assert.strictEqual(t1rows[2].airflow, null);
console.log("Task 1 OK");
