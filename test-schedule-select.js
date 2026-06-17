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

console.log("Task 1 OK");
