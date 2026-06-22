# Schedule Selection — Required vs Proposed Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Schedule Selection feature's summary (WhatsApp chat reply + PDF report) show a consistent Required-vs-Proposed comparison for every row — capacity, condition (T1/T3), on-coil DB/WB, qty, and proposed model — with Required always sourced from the schedule extraction and Proposed always reflecting what the matching engine actually used.

**Architecture:** Add small additive fields (`onCoilSource`, `onCoilDb`, `onCoilWb`) to the three match functions in `schedule-select.js` (`matchSplit`, `matchPackageTrane`, `matchPackageSkm`) so each carries the on-coil basis it actually applied. Add two shared formatter functions in the same file (`formatRequiredBlock`, `formatProposedOnCoil`) consumed by both `buildReply` (chat text) and `generateSchedulePdf` (PDF table), so the two outputs never drift apart.

**Tech Stack:** Plain Node.js, no new dependencies. Tests follow this repo's existing convention — a single assert-based script (`test-schedule-select.js`) run with `node test-schedule-select.js`, with incrementally numbered `// --- Task N: ... ---` blocks. PDF generation uses `pdfkit` (already a dependency, see `schedule-pdf.js`).

## Global Constraints

- Required-side values are never computed or invented — only what the schedule extraction produced (`row.condition`, `row.onCoilDb`, `row.onCoilWb`). Show the literal string `"not specified"` when the schedule didn't print it.
- Proposed-side on-coil must reflect what the matching engine actually used for that specific match — never label a rated-default value as "from schedule".
- All changes to `matchSplit`, `matchPackageTrane`, `matchPackageSkm` are additive only. No existing field is renamed or removed, so every existing assertion in `test-schedule-select.js` keeps passing unless explicitly called out below.
- `buildReply` and `generateSchedulePdf` must stay in sync — both call the same shared formatter functions, never duplicate formatting logic.
- SKM package (APMR/APMR-A) on-coil display is the fixed reference point 26.67°C / 19.44°C (80/67°F) — it is never derived from the schedule and never fed into the capacity lookup, since the SKM package engine has no on-coil sensitivity data at all.

---

### Task 1: Engine layer — expose the applied on-coil basis

**Files:**
- Modify: `schedule-select.js:15-19` (add `RATED_INDOOR` constant after `COND_POINTS`)
- Modify: `schedule-select.js:79-99` (`matchSplit` return)
- Modify: `schedule-select.js:101-129` (`matchPackageSkm` both return statements)
- Modify: `schedule-select.js:131-157` (`matchPackageTrane` return)
- Modify: `schedule-select.js:409-416` (`module.exports`, add `RATED_INDOOR`)
- Test: `test-schedule-select.js` (append a new `Task 9` block at the end, after the existing `console.log("Task 8 OK");` on line 280)

**Interfaces:**
- Consumes: existing `COND_POINTS`, `FAMILIES`, `rankSplit`, `rankModels`, `PRODUCTS`, `unitsToMeetLoad`, `cToF` — all unchanged.
- Produces: a new exported constant `RATED_INDOOR = { db: 26.67, wb: 19.44 }`. Every object returned by `matchSplit`, `matchPackageTrane`, `matchPackageSkm` additionally carries:
  - `onCoilSource: "schedule" | "rated"`
  - `onCoilDb: number` (°C)
  - `onCoilWb: number` (°C)

  These three fields are what Task 2's formatters and Task 3/4's renderers consume — later tasks rely on exactly these names.

- [ ] **Step 1: Write the failing test**

Append to the end of `test-schedule-select.js` (after the line `console.log("Task 8 OK");`):

```js
// --- Task 9: match functions expose the applied on-coil basis for display
// (onCoilSource / onCoilDb / onCoilWb), additive to existing fields ---
const ratedSplit = S.matchSplit(5.0, "PKV", "T3");
assert.strictEqual(ratedSplit.onCoilSource, "rated");
assert.strictEqual(ratedSplit.onCoilDb, S.COND_POINTS.T3.idb);
assert.strictEqual(ratedSplit.onCoilWb, S.COND_POINTS.T3.iwb);
const schedSplit = S.matchSplit(5.0, "PKV", "T3", { db: 27, wb: 19 });
assert.strictEqual(schedSplit.onCoilSource, "schedule");
assert.strictEqual(schedSplit.onCoilDb, 27);
assert.strictEqual(schedSplit.onCoilWb, 19);

const ratedTrane = S.matchPackageTrane(30, "T3");
assert.strictEqual(ratedTrane.onCoilSource, "rated");
assert.strictEqual(ratedTrane.onCoilDb, S.RATED_INDOOR.db);
assert.strictEqual(ratedTrane.onCoilWb, S.RATED_INDOOR.wb);
const schedTrane = S.matchPackageTrane(30, "T3", { db: 27, wb: 19 });
assert.strictEqual(schedTrane.onCoilSource, "schedule");
assert.strictEqual(schedTrane.onCoilDb, 27);
assert.strictEqual(schedTrane.onCoilWb, 19);

const skmPkg = S.matchPackageSkm(14.1, "apmr", "T3");
assert.strictEqual(skmPkg.onCoilSource, "rated");
assert.strictEqual(skmPkg.onCoilDb, S.RATED_INDOOR.db);
assert.strictEqual(skmPkg.onCoilWb, S.RATED_INDOOR.wb);
const skmPkgFallback = S.matchPackageSkm(400, "apmr", "T3"); // exercises the range-exceeded branch
assert.strictEqual(skmPkgFallback.onCoilSource, "rated");
assert.strictEqual(skmPkgFallback.onCoilDb, S.RATED_INDOOR.db);
console.log("Task 9 OK");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-schedule-select.js`
Expected: FAIL — `S.RATED_INDOOR` is `undefined`, so `S.RATED_INDOOR.db` throws `TypeError: Cannot read properties of undefined`. (Tasks 1-8 above it still print "OK" first.)

- [ ] **Step 3: Implement the additive fields**

In `schedule-select.js`, replace lines 15-19:

```js
// Outdoor/indoor rating points + Fahrenheit ambient per condition.
const COND_POINTS = {
  T1: { idb: 27, iwb: 19, odb: 35, ambF: 95 },
  T3: { idb: 29, iwb: 19, odb: 46, ambF: 115 },
};
```

with:

```js
// Outdoor/indoor rating points + Fahrenheit ambient per condition.
const COND_POINTS = {
  T1: { idb: 27, iwb: 19, odb: 35, ambF: 95 },
  T3: { idb: 29, iwb: 19, odb: 46, ambF: 115 },
};

// Standard AHRI rated-indoor reference point (80°F DB / 67°F WB), used as
// the Proposed-side on-coil display whenever an engine falls back to its
// own rated default (Trane) or doesn't model on-coil at all (SKM package).
// Display only — never fed into any capacity lookup.
const RATED_INDOOR = { db: 26.67, wb: 19.44 };
```

Replace the `matchSplit` return (currently lines 90-98):

```js
  return {
    label: best.label,
    capKw: best.tc,
    marginPct: Math.round((best.margin || 0) * 100),
    adequate: !!best.adequate,
    usedOnCoil: hasOC,
    unitsNeeded: qty,
    proposedKw: totalCapKw,
  };
```

with:

```js
  return {
    label: best.label,
    capKw: best.tc,
    marginPct: Math.round((best.margin || 0) * 100),
    adequate: !!best.adequate,
    usedOnCoil: hasOC,
    unitsNeeded: qty,
    proposedKw: totalCapKw,
    onCoilSource: hasOC ? "schedule" : "rated",
    onCoilDb: idb,
    onCoilWb: iwb,
  };
```

Replace `matchPackageSkm`'s first return (the range-exceeded branch, currently lines 124-125):

```js
    return { series, code: max.code, capKw: max[field], adequate: true, fellBack,
             unitsNeeded: qty, proposedKw: totalCapKw };
```

with:

```js
    return { series, code: max.code, capKw: max[field], adequate: true, fellBack,
             unitsNeeded: qty, proposedKw: totalCapKw,
             onCoilSource: "rated", onCoilDb: RATED_INDOOR.db, onCoilWb: RATED_INDOOR.wb };
```

Replace `matchPackageSkm`'s second return (currently lines 127-128):

```js
  return { series, code: hit.code, capKw: hit.capKw, adequate: true, fellBack,
           unitsNeeded: 1, proposedKw: hit.capKw };
```

with:

```js
  return { series, code: hit.code, capKw: hit.capKw, adequate: true, fellBack,
           unitsNeeded: 1, proposedKw: hit.capKw,
           onCoilSource: "rated", onCoilDb: RATED_INDOOR.db, onCoilWb: RATED_INDOOR.wb };
```

Replace the `matchPackageTrane` return (currently lines 151-156):

```js
  return { key: best.key, tons: best.tons, tcMbh: best.r.TC, capKw,
           adequate: !!best.adequate, usedOnCoil: hasOC, ratedCfm, airflowWarn,
           unitsNeeded: qty, proposedKw: totalCapKw,
           // Exact rankModels inputs, so a caller can regenerate this same
           // model's datasheet (generateMtzPdf) without re-deriving them.
           reqTC, db, wb, amb };
```

with:

```js
  return { key: best.key, tons: best.tons, tcMbh: best.r.TC, capKw,
           adequate: !!best.adequate, usedOnCoil: hasOC, ratedCfm, airflowWarn,
           unitsNeeded: qty, proposedKw: totalCapKw,
           // Exact rankModels inputs, so a caller can regenerate this same
           // model's datasheet (generateMtzPdf) without re-deriving them.
           reqTC, db, wb, amb,
           onCoilSource: hasOC ? "schedule" : "rated",
           onCoilDb: hasOC ? onCoil.db : RATED_INDOOR.db,
           onCoilWb: hasOC ? onCoil.wb : RATED_INDOOR.wb };
```

Finally, update `module.exports` (currently lines 409-416) so it includes `RATED_INDOOR`:

```js
module.exports = {
  KW_PER_TR, MBH_PER_KW, COND_POINTS, RATED_INDOOR, SPLIT_FAMILY,
  toKw, toTr, toMbh, parseCondition, lsToCfm, cToF, classifyCategory,
  splitFamilyKey, matchSplit, unitsToMeetLoad,
  matchPackageSkm, matchPackageTrane,
  buildExtractionPrompt, normalizeRows,
  summarize, buildReply, computeSelections, rowsFromScheduleImage,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-schedule-select.js`
Expected: PASS — output ends with `Task 9 OK` (after `Task 8 OK`), no assertion errors.

- [ ] **Step 5: Commit**

```bash
git add schedule-select.js test-schedule-select.js
git commit -m "feat(schedule-select): expose applied on-coil basis on match results"
```

---

### Task 2: Shared Required/Proposed formatter functions

**Files:**
- Modify: `schedule-select.js:235-237` (insert two new functions immediately after `capStr`)
- Modify: `schedule-select.js` `module.exports` (add `formatRequiredBlock`, `formatProposedOnCoil`)
- Test: `test-schedule-select.js` (append `Task 10` block)

**Interfaces:**
- Consumes: `capStr` (same file). No dependency on Task 1's `RATED_INDOOR` directly — these formatters only read whatever the row/match object already carries.
- Produces:
  - `formatRequiredBlock(row) -> { capTxt: string, condTxt: string, onCoilTxt: string }` — `row` is any normalized row from `normalizeRows` (needs `requiredKw`, `condition`, `onCoilDb`, `onCoilWb`).
  - `formatProposedOnCoil(match) -> string` — `match` is any object carrying `onCoilSource`, `onCoilDb`, `onCoilWb` (i.e. any return value from `matchSplit`, `matchPackageTrane`, or `matchPackageSkm` after Task 1).

  Task 3 (`buildReply`) and Task 4 (`generateSchedulePdf`) both call these two functions directly — their exact return shape above is what those tasks rely on.

- [ ] **Step 1: Write the failing test**

Append to the end of `test-schedule-select.js` (after the `Task 9` block from the previous task):

```js
// --- Task 10: formatRequiredBlock / formatProposedOnCoil render condition
// and on-coil consistently, with "not specified" / source labels ---
const reqWithData = S.formatRequiredBlock({ requiredKw: 14.07, condition: "T3", onCoilDb: 27, onCoilWb: 19 });
assert.strictEqual(reqWithData.condTxt, "T3");
assert.strictEqual(reqWithData.onCoilTxt, "27/19°C");
const reqNoData = S.formatRequiredBlock({ requiredKw: 14.07, condition: null, onCoilDb: null, onCoilWb: null });
assert.strictEqual(reqNoData.condTxt, "not specified");
assert.strictEqual(reqNoData.onCoilTxt, "not specified");

assert.strictEqual(
  S.formatProposedOnCoil({ onCoilSource: "schedule", onCoilDb: 27, onCoilWb: 19 }),
  "27/19°C (from schedule)"
);
assert.strictEqual(
  S.formatProposedOnCoil({ onCoilSource: "rated", onCoilDb: S.RATED_INDOOR.db, onCoilWb: S.RATED_INDOOR.wb }),
  "26.67/19.44°C (rated default)"
);
console.log("Task 10 OK");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-schedule-select.js`
Expected: FAIL — `S.formatRequiredBlock is not a function`.

- [ ] **Step 3: Implement the formatters**

In `schedule-select.js`, immediately after the `capStr` function (currently lines 235-237):

```js
function capStr(kw) {
  return `${toTr(kw).toFixed(1)} TR (${kw.toFixed(1)} kW)`;
}
```

insert:

```js
// Format a Celsius value for display: up to 2 decimals, trailing zeros
// trimmed (27 -> "27", 26.67 -> "26.67", 19.40 -> "19.4").
function degC(v) {
  return Number(v).toFixed(2).replace(/\.?0+$/, "");
}

// Required-side text for a normalized row: capacity, condition, and
// on-coil — straight from the schedule, "not specified" when the schedule
// didn't print it. Used verbatim by both buildReply (chat) and
// schedule-pdf.js (PDF "Required" column) so wording never drifts.
function formatRequiredBlock(row) {
  return {
    capTxt: capStr(row.requiredKw),
    condTxt: row.condition || "not specified",
    onCoilTxt: (row.onCoilDb != null && row.onCoilWb != null)
      ? `${degC(row.onCoilDb)}/${degC(row.onCoilWb)}°C`
      : "not specified",
  };
}

// Proposed-side on-coil text: the DB/WB the matching engine actually
// assumed, labeled by source so a rated default is never confused with a
// schedule value the engine didn't use. Works for any match object that
// carries onCoilDb/onCoilWb/onCoilSource (matchSplit, matchPackageTrane,
// matchPackageSkm all do, as of Task 1).
function formatProposedOnCoil(match) {
  const src = match.onCoilSource === "schedule" ? "from schedule" : "rated default";
  return `${degC(match.onCoilDb)}/${degC(match.onCoilWb)}°C (${src})`;
}
```

Update `module.exports` to add the two new functions:

```js
module.exports = {
  KW_PER_TR, MBH_PER_KW, COND_POINTS, RATED_INDOOR, SPLIT_FAMILY,
  toKw, toTr, toMbh, parseCondition, lsToCfm, cToF, classifyCategory,
  splitFamilyKey, matchSplit, unitsToMeetLoad,
  matchPackageSkm, matchPackageTrane,
  formatRequiredBlock, formatProposedOnCoil,
  buildExtractionPrompt, normalizeRows,
  summarize, buildReply, computeSelections, rowsFromScheduleImage,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-schedule-select.js`
Expected: PASS — output ends with `Task 10 OK`.

- [ ] **Step 5: Commit**

```bash
git add schedule-select.js test-schedule-select.js
git commit -m "feat(schedule-select): add shared Required/Proposed on-coil formatters"
```

---

### Task 3: Wire formatters into the WhatsApp reply (`buildReply`)

**Files:**
- Modify: `schedule-select.js:295-327` (package-results loop inside `buildReply`)
- Modify: `schedule-select.js:334-351` (split-results loop inside `buildReply`)
- Modify: `test-schedule-select.js` lines 172-182 (existing `Task 3` block — its old "SKM split must NOT show on-coil" assertion is superseded by this change)
- Test: `test-schedule-select.js` (append new `Task 11` block)

**Interfaces:**
- Consumes: `formatRequiredBlock`, `formatProposedOnCoil` from Task 2 (same file, no import needed). `cond` is already in scope inside `buildReply` via `const { cond, splitBrand, pkgVendor, pkgSeries } = choices;` (line 280, unchanged).
- Produces: `buildReply(rows, skipped, choices) -> string` keeps its exact existing signature; only the per-row text changes. Task 4 does not consume `buildReply` directly, but mirrors its wording in the PDF using the same two formatters.

- [ ] **Step 1: Update the existing Task 3 test and write the new Task 11 test**

In `test-schedule-select.js`, find this existing block (lines 172-182):

```js
// --- Task 3: buildReply tags on-coil for Toshiba split rows ---
const ocRows = S.normalizeRows([
  { location: "Office", type: "SPLIT", capacity: 18000, unit: "BTU/HR", qty: 1,
    onCoilDb: 27, onCoilWb: 19 },
]).rows;
const tReply = S.buildReply(ocRows, [], { cond: "T3", splitBrand: "toshiba" });
assert.match(tReply, /on-coil/i);
// SKM split with the same row must NOT use on-coil
const sReply = S.buildReply(ocRows, [], { cond: "T3", splitBrand: "skm" });
assert.doesNotMatch(sReply, /on-coil/i);
console.log("Task 3 OK");
```

Replace it with:

```js
// --- Task 3: buildReply tags on-coil for Toshiba split rows ---
const ocRows = S.normalizeRows([
  { location: "Office", type: "SPLIT", capacity: 18000, unit: "BTU/HR", qty: 1,
    onCoilDb: 27, onCoilWb: 19 },
]).rows;
const tReply = S.buildReply(ocRows, [], { cond: "T3", splitBrand: "toshiba" });
assert.match(tReply, /on-coil/i);
assert.match(tReply, /Proposed:.*On-coil: 27\/19°C \(from schedule\)/);
// SKM split with the same row shows on-coil too, but as the rated default —
// SKM/TCL split matching doesn't consume schedule on-coil, so the Proposed
// side must never claim "from schedule" for a value it didn't use.
const sReply = S.buildReply(ocRows, [], { cond: "T3", splitBrand: "skm" });
assert.match(sReply, /Proposed:.*On-coil: 29\/19°C \(rated default\)/);
assert.doesNotMatch(sReply, /Proposed:[^\n]*from schedule/);
console.log("Task 3 OK");
```

Append a new block at the end of the file (after `Task 10 OK`):

```js
// --- Task 11: buildReply prints Required + Proposed condition/on-coil
// consistently across all four vendor paths ---

// Trane: Required side shows the schedule's own condition/on-coil; Proposed
// side shows what matchPackageTrane actually used.
const traneRows = S.normalizeRows([
  { location: "AHU-1", type: "PACKAGE AC", capacity: 12, unit: "TR", qty: 1,
    condition: "T3", onCoilDb: 27, onCoilWb: 19 },
]).rows;
const traneReply = S.buildReply(traneRows, [], { cond: "T3", pkgVendor: "trane" });
assert.match(traneReply, /Required:.*T3.*On-coil: 27\/19°C/);
assert.match(traneReply, /Proposed:.*On-coil: 27\/19°C \(from schedule\)/);

const traneNoOcRows = S.normalizeRows([
  { location: "AHU-2", type: "PACKAGE AC", capacity: 12, unit: "TR", qty: 1 },
]).rows;
const traneNoOcReply = S.buildReply(traneNoOcRows, [], { cond: "T3", pkgVendor: "trane" });
assert.match(traneNoOcReply, /Required:.*not specified.*On-coil: not specified/);
assert.match(traneNoOcReply, /Proposed:.*On-coil: 26\.67\/19\.44°C \(rated default\)/);

// SKM package: never modeled, always the rated default — and never claims
// "from schedule" even when the schedule prints on-coil for that row.
const skmPkgRows = S.normalizeRows([
  { location: "Plant Room", type: "PACKAGE AC", capacity: 14, unit: "TR", qty: 1,
    condition: "T3", onCoilDb: 27, onCoilWb: 19 },
]).rows;
const skmPkgReply = S.buildReply(skmPkgRows, [], { cond: "T3", pkgVendor: "skm", pkgSeries: "apmr" });
assert.match(skmPkgReply, /Required:.*T3.*On-coil: 27\/19°C/);
assert.match(skmPkgReply, /Proposed:.*On-coil: 26\.67\/19\.44°C \(rated default\)/);
assert.doesNotMatch(skmPkgReply, /Proposed:[^\n]*from schedule/);
console.log("Task 11 OK");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-schedule-select.js`
Expected: FAIL — the modified `Task 3` assertions fail first (`sReply` doesn't yet contain "rated default"; old code never prints on-coil for SKM splits at all).

- [ ] **Step 3: Implement the `buildReply` changes**

In `schedule-select.js`, replace the package-results loop body (currently lines 295-327):

```js
    for (const { row: r, vendor, match: m } of pkgResults) {
      totalReqKw += r.requiredKw * r.qty;
      if (vendor === "trane") {
        totalProposedKw += m.proposedKw * r.qty;
        const multi = m.unitsNeeded > 1;
        if (multi) multiUnitLocations.push(r.location);
        const ocTag = m.usedOnCoil
          ? `(on-coil ${r.onCoilDb}/${r.onCoilWb}°C from schedule)` : "(rated indoor 80/67°F)";
        const air = r.airflow != null ? ` · airflow ${Math.round(r.airflow)} CFM` : "";
        const proposedLine = multi
          ? `${m.unitsNeeded}× MTZ ${m.key} (${m.tons} TR each) = ${capStr(m.proposedKw)}`
          : `MTZ ${m.key} · ${m.tons} TR`;
        lines.push(`• ${r.location} — Required: ${capStr(r.requiredKw)} ×${r.qty}${air}`,
          `   → Proposed: ${proposedLine} · ✅ _${ocTag}_${multi ? " · ↪ multiple units in parallel" : ""}`);
        if (m.airflowWarn) {
          lines.push(`   ⚠️ airflow off rated CFM (req ${m.airflowWarn.req} / rated ${m.airflowWarn.rated})`);
        }
      } else {
        totalProposedKw += m.proposedKw * r.qty;
        const multi = m.unitsNeeded > 1;
        if (multi) multiUnitLocations.push(r.location);
        const name = `${m.series === "apmr-a" ? "APMR-A" : "APMR"} ${m.code}`;
        const tags = [];
        if (m.fellBack) tags.push("↪ APMR-A (APMR range exceeded)");
        if (multi) tags.push("↪ multiple units in parallel");
        tags.push("✅");
        const proposedLine = multi
          ? `${m.unitsNeeded}× ${name} (${m.capKw.toFixed(1)} kW each) = ${capStr(m.proposedKw)}`
          : `${name} · ${m.capKw.toFixed(1)} kW`;
        lines.push(`• ${r.location} — Required: ${capStr(r.requiredKw)} ×${r.qty}`,
          `   → Proposed: ${proposedLine} ${cond} · ${tags.join(" · ")}`);
      }
    }
```

with:

```js
    for (const { row: r, vendor, match: m } of pkgResults) {
      totalReqKw += r.requiredKw * r.qty;
      const req = formatRequiredBlock(r);
      if (vendor === "trane") {
        totalProposedKw += m.proposedKw * r.qty;
        const multi = m.unitsNeeded > 1;
        if (multi) multiUnitLocations.push(r.location);
        const air = r.airflow != null ? ` · airflow ${Math.round(r.airflow)} CFM` : "";
        const proposedLine = multi
          ? `${m.unitsNeeded}× MTZ ${m.key} (${m.tons} TR each) = ${capStr(m.proposedKw)}`
          : `MTZ ${m.key} · ${m.tons} TR`;
        lines.push(
          `• ${r.location} — Required: ${req.capTxt} ×${r.qty} · ${req.condTxt} · On-coil: ${req.onCoilTxt}${air}`,
          `   → Proposed: ${proposedLine} · ${cond} · On-coil: ${formatProposedOnCoil(m)} · ✅${multi ? " · ↪ multiple units in parallel" : ""}`
        );
        if (m.airflowWarn) {
          lines.push(`   ⚠️ airflow off rated CFM (req ${m.airflowWarn.req} / rated ${m.airflowWarn.rated})`);
        }
      } else {
        totalProposedKw += m.proposedKw * r.qty;
        const multi = m.unitsNeeded > 1;
        if (multi) multiUnitLocations.push(r.location);
        const name = `${m.series === "apmr-a" ? "APMR-A" : "APMR"} ${m.code}`;
        const tags = [];
        if (m.fellBack) tags.push("↪ APMR-A (APMR range exceeded)");
        if (multi) tags.push("↪ multiple units in parallel");
        tags.push("✅");
        const proposedLine = multi
          ? `${m.unitsNeeded}× ${name} (${m.capKw.toFixed(1)} kW each) = ${capStr(m.proposedKw)}`
          : `${name} · ${m.capKw.toFixed(1)} kW`;
        lines.push(
          `• ${r.location} — Required: ${req.capTxt} ×${r.qty} · ${req.condTxt} · On-coil: ${req.onCoilTxt}`,
          `   → Proposed: ${proposedLine} · ${cond} · On-coil: ${formatProposedOnCoil(m)} · ${tags.join(" · ")}`
        );
      }
    }
```

Replace the split-results loop body (currently lines 334-351):

```js
    for (const { row: r, match: m, error } of splitResults) {
      totalReqKw += r.requiredKw * r.qty;
      if (error) {
        lines.push(`• ${r.location} — Required: ${capStr(r.requiredKw)} ×${r.qty}`,
          `   → ⚠️ ${error}`);
        continue;
      }
      totalProposedKw += m.proposedKw * r.qty;
      const multi = m.unitsNeeded > 1;
      if (multi) multiUnitLocations.push(r.location);
      const kind = r.category === "ducted" ? "ducted" : "hi-wall";
      const ocTag = m.usedOnCoil ? ` · (on-coil ${r.onCoilDb}/${r.onCoilWb}°C from schedule)` : "";
      const proposedLine = multi
        ? `${m.unitsNeeded}× ${m.label} (${m.capKw.toFixed(1)} kW each) = ${capStr(m.proposedKw)}`
        : `${m.label} · ${m.capKw.toFixed(1)} kW`;
      lines.push(`• ${r.location} (${kind}) — Required: ${capStr(r.requiredKw)} ×${r.qty}`,
        `   → Proposed: ${proposedLine} ${cond} · ✅${multi ? " · ↪ multiple units in parallel" : ""}${ocTag}`);
    }
```

with:

```js
    for (const { row: r, match: m, error } of splitResults) {
      totalReqKw += r.requiredKw * r.qty;
      const req = formatRequiredBlock(r);
      if (error) {
        lines.push(
          `• ${r.location} — Required: ${req.capTxt} ×${r.qty} · ${req.condTxt} · On-coil: ${req.onCoilTxt}`,
          `   → ⚠️ ${error}`
        );
        continue;
      }
      totalProposedKw += m.proposedKw * r.qty;
      const multi = m.unitsNeeded > 1;
      if (multi) multiUnitLocations.push(r.location);
      const kind = r.category === "ducted" ? "ducted" : "hi-wall";
      const proposedLine = multi
        ? `${m.unitsNeeded}× ${m.label} (${m.capKw.toFixed(1)} kW each) = ${capStr(m.proposedKw)}`
        : `${m.label} · ${m.capKw.toFixed(1)} kW`;
      lines.push(
        `• ${r.location} (${kind}) — Required: ${req.capTxt} ×${r.qty} · ${req.condTxt} · On-coil: ${req.onCoilTxt}`,
        `   → Proposed: ${proposedLine} · ${cond} · On-coil: ${formatProposedOnCoil(m)} · ✅${multi ? " · ↪ multiple units in parallel" : ""}`
      );
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-schedule-select.js`
Expected: PASS — output ends with `Task 11 OK`, and every earlier `Task N OK` line still prints (Tasks 1–10 unaffected).

- [ ] **Step 5: Commit**

```bash
git add schedule-select.js test-schedule-select.js
git commit -m "feat(schedule-select): show Required/Proposed condition and on-coil in buildReply"
```

---

### Task 4: Wire formatters into the PDF report

**Files:**
- Modify: `schedule-pdf.js:8-11` (imports)
- Modify: `schedule-pdf.js:79` (`COL_W`)
- Modify: `schedule-pdf.js:136-152` (package-results loop)
- Modify: `schedule-pdf.js:163-180` (split-results loop)
- No automated test file exists for `schedule-pdf.js` in this repo (consistent with existing convention — verified manually, per the design spec).

**Interfaces:**
- Consumes: `formatRequiredBlock`, `formatProposedOnCoil` from `schedule-select.js` (Task 2), imported alongside the existing `toTr` import. `cond` is already a parameter of `generateSchedulePdf` (unchanged).
- Produces: `generateSchedulePdf(opts) -> Promise<Buffer>` keeps its exact existing signature — only the rendered table content changes.

- [ ] **Step 1: Update the import**

In `schedule-pdf.js`, replace line 11:

```js
const { toTr } = schedule;
```

with:

```js
const { toTr, formatRequiredBlock, formatProposedOnCoil } = schedule;
```

- [ ] **Step 2: Widen the Required/Proposed columns**

Replace line 79:

```js
    const COL_W = [22, 110, 80, 30, 190, 83];
```

with:

```js
    const COL_W = [22, 110, 95, 30, 175, 83];
```

(Required grows from 80pt to 95pt, Proposed Selection shrinks from 190pt to 175pt — same total of 515pt. Both columns now carry 3 lines of text instead of 1-2.)

- [ ] **Step 3: Update the package-results loop**

Replace the loop body (currently lines 136-152):

```js
      for (const { row: r, vendor, match: m } of pkgResults) {
        pkgReqKw += r.requiredKw * r.qty;
        pkgPropKw += m.proposedKw * r.qty;
        totalReqKw += r.requiredKw * r.qty;
        totalProposedKw += m.proposedKw * r.qty;
        const multi = m.unitsNeeded > 1;
        if (multi) multiUnitLocations.push(r.location);
        const proposed = vendor === "trane"
          ? (multi ? `${m.unitsNeeded}× MTZ ${m.key}\n(${m.tons} TR each)` : `MTZ ${m.key} · ${m.tons} TR`)
          : (() => {
              const name = `${m.series === "apmr-a" ? "APMR-A" : "APMR"} ${m.code}`;
              return multi ? `${m.unitsNeeded}× ${name}\n(${m.capKw.toFixed(1)} kW each)` : `${name} · ${m.capKw.toFixed(1)} kW`;
            })();
        const status = multi ? `OK · ${m.unitsNeeded}× parallel` : "OK";
        rowNum += 1;
        tableDataRow([String(rowNum), r.location, capCell(r.requiredKw), `×${r.qty}`, proposed, status], true);
      }
```

with:

```js
      for (const { row: r, vendor, match: m } of pkgResults) {
        pkgReqKw += r.requiredKw * r.qty;
        pkgPropKw += m.proposedKw * r.qty;
        totalReqKw += r.requiredKw * r.qty;
        totalProposedKw += m.proposedKw * r.qty;
        const multi = m.unitsNeeded > 1;
        if (multi) multiUnitLocations.push(r.location);
        const req = formatRequiredBlock(r);
        const requiredCell = `${capCell(r.requiredKw)}\n${req.condTxt}\nOn-coil: ${req.onCoilTxt}`;
        const proposedModel = vendor === "trane"
          ? (multi ? `${m.unitsNeeded}× MTZ ${m.key} (${m.tons} TR each)` : `MTZ ${m.key} · ${m.tons} TR`)
          : (() => {
              const name = `${m.series === "apmr-a" ? "APMR-A" : "APMR"} ${m.code}`;
              return multi ? `${m.unitsNeeded}× ${name} (${m.capKw.toFixed(1)} kW each)` : `${name} · ${m.capKw.toFixed(1)} kW`;
            })();
        const proposed = `${proposedModel}\n${cond}\nOn-coil: ${formatProposedOnCoil(m)}`;
        const status = multi ? `OK · ${m.unitsNeeded}× parallel` : "OK";
        rowNum += 1;
        tableDataRow([String(rowNum), r.location, requiredCell, `×${r.qty}`, proposed, status], true, 48);
      }
```

- [ ] **Step 4: Update the split-results loop**

Replace the loop body (currently lines 163-180):

```js
      for (const { row: r, match: m, error } of splitResults) {
        splitReqKw += r.requiredKw * r.qty;
        totalReqKw += r.requiredKw * r.qty;
        rowNum += 1;
        if (error) {
          tableDataRow([String(rowNum), r.location, capCell(r.requiredKw), `×${r.qty}`, error, "VERIFY"], false);
          continue;
        }
        splitPropKw += m.proposedKw * r.qty;
        totalProposedKw += m.proposedKw * r.qty;
        const multi = m.unitsNeeded > 1;
        if (multi) multiUnitLocations.push(r.location);
        const proposed = multi
          ? `${m.unitsNeeded}× ${m.label}\n(${m.capKw.toFixed(1)} kW each)`
          : `${m.label} · ${m.capKw.toFixed(1)} kW`;
        const status = multi ? `OK · ${m.unitsNeeded}× parallel` : "OK";
        tableDataRow([String(rowNum), r.location, capCell(r.requiredKw), `×${r.qty}`, proposed, status], true);
      }
```

with:

```js
      for (const { row: r, match: m, error } of splitResults) {
        splitReqKw += r.requiredKw * r.qty;
        totalReqKw += r.requiredKw * r.qty;
        rowNum += 1;
        const req = formatRequiredBlock(r);
        const requiredCell = `${capCell(r.requiredKw)}\n${req.condTxt}\nOn-coil: ${req.onCoilTxt}`;
        if (error) {
          tableDataRow([String(rowNum), r.location, requiredCell, `×${r.qty}`, error, "VERIFY"], false, 48);
          continue;
        }
        splitPropKw += m.proposedKw * r.qty;
        totalProposedKw += m.proposedKw * r.qty;
        const multi = m.unitsNeeded > 1;
        if (multi) multiUnitLocations.push(r.location);
        const proposedModel = multi
          ? `${m.unitsNeeded}× ${m.label} (${m.capKw.toFixed(1)} kW each)`
          : `${m.label} · ${m.capKw.toFixed(1)} kW`;
        const proposed = `${proposedModel}\n${cond}\nOn-coil: ${formatProposedOnCoil(m)}`;
        const status = multi ? `OK · ${m.unitsNeeded}× parallel` : "OK";
        tableDataRow([String(rowNum), r.location, requiredCell, `×${r.qty}`, proposed, status], true, 48);
      }
```

- [ ] **Step 5: Generate a sample PDF and visually verify layout**

Create a throwaway script at the repo root, run it, then delete it — this is not a permanent test file (no PDF-testing convention exists in this repo, see Files note above).

```js
// __gen-sample-schedule-pdf.js (temporary — delete after use)
const { generateSchedulePdf } = require("./schedule-pdf.js");
const schedule = require("./schedule-select.js");

const { rows } = schedule.normalizeRows([
  { location: "AHU-1", type: "PACKAGE AC", capacity: 12, unit: "TR", qty: 1,
    condition: "T3", onCoilDb: 27, onCoilWb: 19, airflow: 4500, airflowUnit: "CFM" },
  { location: "Plant Room", type: "PACKAGE AC", capacity: 400, unit: "TR", qty: 1 },
  { location: "Office", type: "SPLIT", capacity: 18000, unit: "BTU/HR", qty: 1,
    onCoilDb: 27, onCoilWb: 19 },
  { location: "Lobby", type: "Ducted split", capacity: 24000, unit: "BTU/HR", qty: 1 },
]);

generateSchedulePdf({
  cond: "T3", splitBrand: "toshiba", pkgVendor: "skm", pkgSeries: "apmr",
  rows, skipped: [],
}).then((buf) => require("fs").writeFileSync("__sample-schedule.pdf", buf));
```

Run: `node __gen-sample-schedule-pdf.js`

Then open `__sample-schedule.pdf` (e.g. with the `pdf-viewer` tool/skill available in this environment, or any PDF viewer) and visually confirm:
- The Required column shows 4 lines (TR, kW, condition, on-coil) fully visible, not clipped or overlapping the row border.
- The Proposed Selection column shows model + condition + on-coil fully visible.
- No text overlaps the row below it.

If anything is clipped or overlapping, increase the `48` row-height argument (both `tableDataRow` call sites touched in Steps 3-4) or adjust `COL_W` from Step 2, then regenerate and re-check.

Once satisfied, delete the throwaway script and sample PDF:

```bash
rm __gen-sample-schedule-pdf.js __sample-schedule.pdf
```

- [ ] **Step 6: Run the full existing test suite as a regression check**

Run: `node test-schedule-select.js`
Expected: PASS — all `Task 1` through `Task 11 OK` lines print (schedule-pdf.js has no assertions of its own, but this confirms Tasks 1-3 are still intact after Task 4's edits).

- [ ] **Step 7: Commit**

```bash
git add schedule-pdf.js
git commit -m "feat(schedule-pdf): show Required/Proposed condition and on-coil in the PDF table"
```
