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

console.log("Task 3 OK");
