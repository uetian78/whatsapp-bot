const assert = require("node:assert");
const { detectSeriesEntry, filenameFor, CATALOGUE_MAP } = require("./catalogue-map.js");

// New: Hi-Wall Non-Inverter
const hiWall = detectSeriesEntry("hi wall non inverter split catalogue");
assert.ok(hiWall, "Hi-Wall Non-Inverter should be detected");
assert.strictEqual(hiWall.name, "Hi-Wall Non-Inverter");
assert.strictEqual(
  filenameFor(hiWall, "Catalogue"),
  "SKM Wall Mounted Hi Wall Split - Non Inverter (Qatar).pdf"
);
assert.strictEqual(filenameFor(hiWall, "IOM"), null);

// New: Sierra Ducted Split
const sierra = detectSeriesEntry("sierra series catalogue");
assert.ok(sierra, "Sierra Ducted Split should be detected");
assert.strictEqual(sierra.name, "Sierra Ducted Split");
assert.strictEqual(
  filenameFor(sierra, "Catalogue"),
  "SKM Ducted Split_Catalogue - Sierra Series - R0 CBU_RX+DDP 052c 50Hz (1).pdf"
);

// Regression: existing series still resolve correctly (no alias collision)
assert.strictEqual(detectSeriesEntry("apmr catalogue").name, "APMR");
assert.strictEqual(detectSeriesEntry("apmr-a catalogue").name, "APMR-A");

// Structural guard: every entry's own canonical name must resolve back to
// itself through detectSeriesEntry — this is the path seriesMenu() uses
// (products.js calls detectSeriesEntry(entry.name), not just raw user text),
// so an alias list that doesn't cover the entry's own name silently breaks
// the Catalogue/IOM button flow for that series.
for (const entry of CATALOGUE_MAP) {
  const resolved = detectSeriesEntry(entry.name);
  assert.ok(resolved, `detectSeriesEntry(${JSON.stringify(entry.name)}) should resolve to an entry, got null`);
  assert.strictEqual(resolved.name, entry.name, `detectSeriesEntry(${JSON.stringify(entry.name)}) resolved to "${resolved.name}" instead of itself`);
}

console.log("All catalogue-map.js tests passed.");
