# Schedule On-Coil, Airflow & Condition-Aware Enhancements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing WhatsApp schedule-selection flow honor the rating condition, on-coil air conditions, and airflow that a schedule prints — instead of always asking T1/T3 and always matching at standard rated indoor conditions.

**Architecture:** Pure selection/normalization logic lives in `schedule-select.js` (unit-tested by the plain-node script `test-schedule-select.js`). The webhook session machine in `server.js` consumes that module. This plan adds optional fields to the extracted row, auto-detects the condition, feeds on-coil to the Toshiba split and Trane MTZ paths only, and validates package airflow against the model's rated CFM. No engine rewrite; `split-engine.rankSplit` already accepts indoor DB/WB and `mtz-engine.rankModels` already returns `fan.cfm_rated`.

**Tech Stack:** Node.js (CommonJS), `node:assert` test script (no test framework), Anthropic Messages API for vision extraction.

## Global Constraints

- Run tests with: `node test-schedule-select.js` (there is **no** `npm test`; it is a plain script that throws on first failed assert and prints `Task N OK` lines).
- New extracted-row fields are **optional**. Absence must degrade to the existing standard-condition path for that row; only an unreadable **capacity** sends a row to the `skipped` verify list.
- On-coil is applied for **Toshiba split and Trane MTZ package only**. TCL split, SKM split, and SKM package keep standard rated indoor — do not change them.
- SKM package selection stays capacity-at-condition (`matchPackageSkm` unchanged).
- Airflow is capture/display/validate only (±15% vs rated CFM). Do **not** change MTZ selection logic.
- On-coil values from the schedule are in **°C**. The split engine wants °C (`rankSplit`); the MTZ engine wants **°F** (`rankModels`) — convert.
- Condition mapping: explicit `T1`/`T3` token wins; else ambient `≈35°C` ⇒ T1, `≈46°C` ⇒ T3; unrecognized ⇒ `null` (never guess).
- Do not regress existing asserts in `test-schedule-select.js` or the VRF image flow.
- Conversions already in the module: `KW_PER_TR = 3.51685`, `MBH_PER_KW = 3.412142`. Add `1 L/s = 2.11888 CFM` and `°F = °C × 9/5 + 32` as needed.

---

## File Structure

- Modify: `schedule-select.js` — extraction prompt, `normalizeRows`, `summarize`, `matchSplit`, `matchPackageTrane`, `buildReply`, `rowsFromScheduleImage` (Tasks 1–4).
- Modify: `test-schedule-select.js` — append assertion blocks (Tasks 1–4).
- Modify: `server.js` — `handleScheduleStep` awaitImage branch only (Task 5).

---

## Task 1: Extract on-coil, airflow & condition fields into the row

**Files:**
- Modify: `schedule-select.js` — `buildExtractionPrompt()` (lines ~103-119) and `normalizeRows()` (lines ~123-150); add an `lsToCfm` helper and a `parseCondition` helper near the other converters (lines ~28-42).
- Test: `test-schedule-select.js` (append block).

**Interfaces:**
- Consumes: existing `classifyCategory`, `toKw`.
- Produces: `normalizeRows(rawArray)` returns rows that now also carry
  `condition: "T1"|"T3"|null`, `onCoilDb: number|null`, `onCoilWb: number|null`,
  `airflow: number|null` (CFM). Also exports `parseCondition(token, ambientC)` and
  `lsToCfm(v)`.

- [ ] **Step 1: Write the failing test** — append before the final `console.log("Task 6 OK");` line in `test-schedule-select.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-schedule-select.js`
Expected: throws `TypeError: S.parseCondition is not a function` (or AssertionError) before printing `Task 1 OK`.

- [ ] **Step 3: Add the helpers** — in `schedule-select.js`, after the `toMbh` function (around line 33) add:

```javascript
function lsToCfm(v) { return v * 2.11888; }

// token wins; else map ambient °C to T1/T3; unrecognized → null (never guess)
function parseCondition(token, ambientC) {
  const t = String(token || "").trim().toUpperCase();
  if (t === "T1" || t === "T3") return t;
  const a = parseFloat(ambientC);
  if (!isNaN(a)) {
    if (a >= 42) return "T3";
    if (a >= 30) return "T1";
  }
  return null;
}

function numOrNull(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}
```

- [ ] **Step 4: Extend the extraction prompt** — in `buildExtractionPrompt()` replace the object-shape lines so the JSON contract requests the new fields (add these keys to the element description, and append the guidance sentences). The element shape block becomes:

```javascript
function buildExtractionPrompt() {
  return [
    "You are extracting an HVAC equipment / AC unit schedule. Return ONLY a JSON",
    "array, no prose, no markdown fences. Each element:",
    '{"location": <room/area/tag text or "">,',
    ' "type": <the TYPE cell text exactly as written, e.g. "SPLIT", "PACKAGE AC", "DUCTED">,',
    ' "category": <"split" | "ducted" | "package" — your best read of the unit kind>,',
    ' "capacity": <the SPECIFIED/REQUIRED cooling capacity NUMBER exactly as printed>,',
    ' "unit": <capacity unit EXACTLY as printed: "kW","TR","ton","BTU/HR","MBH","kcal/h"; "" if none>,',
    ' "qty": <integer, default 1>,',
    ' "condition": <"T1" or "T3" ONLY if the schedule explicitly prints it, else "">,',
    ' "ambientC": <outdoor ambient temperature in °C as a NUMBER if printed (e.g. 46), else "">,',
    ' "onCoilDb": <entering-air dry-bulb to the indoor coil in °C as a NUMBER if printed, else "">,',
    ' "onCoilWb": <entering-air wet-bulb to the indoor coil in °C as a NUMBER if printed, else "">,',
    ' "airflow": <air volume NUMBER if printed (package units), else "">,',
    ' "airflowUnit": <"CFM" or "L/s" exactly as printed, else "">}',
    "Use the SPECIFIED/required capacity, not any competitor 'offered' column.",
    "Only fill condition / ambientC / onCoilDb / onCoilWb / airflow when they are",
    "actually printed on the schedule. NEVER guess or invent them; leave \"\" if absent.",
    "If the table heading says the units are splits, treat rows as split unless a",
    "row says ducted. Copy the capacity value and unit EXACTLY; do NOT convert.",
    "A cell like '48,000x8' means capacity 48000 and qty 8. Do not invent rows. If",
    "you cannot confidently read a capacity, OMIT that row. Return [] if no schedule.",
  ].join(" ");
}
```

- [ ] **Step 5: Populate the new fields in `normalizeRows`** — inside the `rows.push({...})` call, add the new fields after `srcUnit`:

```javascript
    rows.push({
      location: String(r.location || ""),
      type: String(r.type || ""),
      category,
      requiredKw,
      qty: parseInt(r.qty, 10) || 1,
      srcValue: value,
      srcUnit: String(r.unit || ""),
      condition: parseCondition(r.condition, r.ambientC),
      onCoilDb: numOrNull(r.onCoilDb),
      onCoilWb: numOrNull(r.onCoilWb),
      airflow: (() => {
        const a = numOrNull(r.airflow);
        if (a == null) return null;
        return String(r.airflowUnit || "").toLowerCase().includes("l/s") ? lsToCfm(a) : a;
      })(),
    });
```

- [ ] **Step 6: Export the new helpers** — in `module.exports`, add `parseCondition, lsToCfm` to the list.

- [ ] **Step 7: Run tests to verify they pass**

Run: `node test-schedule-select.js`
Expected: prints `Task 6 OK` and `Task 1 OK`, no AssertionError.

- [ ] **Step 8: Commit**

```bash
git add schedule-select.js test-schedule-select.js
git commit -m "feat(schedule): extract condition, on-coil & airflow fields"
```

---

## Task 2: Schedule-level condition detection + propagate from extraction

**Files:**
- Modify: `schedule-select.js` — `summarize()` (lines ~152-158) and `rowsFromScheduleImage()` return (line ~260).
- Test: `test-schedule-select.js` (append block).

**Interfaces:**
- Consumes: rows from Task 1 (each may carry `condition`).
- Produces: `summarize(rows)` now also returns `scheduleCondition: "T1"|"T3"|null`
  (non-null only if every condition-bearing row agrees and at least one exists).
  `rowsFromScheduleImage(...)` resolves to `{ rows, skipped, scheduleCondition }`.

- [ ] **Step 1: Write the failing test** — append before the last `console.log` line:

```javascript
// --- Task 2: summarize derives a schedule-level condition ---
const agree = S.summarize([
  { category: "split", condition: "T3" },
  { category: "package", condition: "T3" },
]);
assert.strictEqual(agree.scheduleCondition, "T3");

const conflict = S.summarize([
  { category: "split", condition: "T1" },
  { category: "package", condition: "T3" },
]);
assert.strictEqual(conflict.scheduleCondition, null);  // rows disagree → ask

const none = S.summarize([
  { category: "split", condition: null },
  { category: "package", condition: null },
]);
assert.strictEqual(none.scheduleCondition, null);
console.log("Task 2 OK");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-schedule-select.js`
Expected: AssertionError on `agree.scheduleCondition` (currently `undefined`).

- [ ] **Step 3: Extend `summarize`** — replace the function body:

```javascript
function summarize(rows) {
  const found = rows.map((r) => r.condition).filter((c) => c === "T1" || c === "T3");
  const uniq = [...new Set(found)];
  return {
    count: rows.length,
    hasSplit: rows.some((r) => r.category === "split" || r.category === "ducted"),
    hasPackage: rows.some((r) => r.category === "package"),
    scheduleCondition: uniq.length === 1 ? uniq[0] : null,
  };
}
```

- [ ] **Step 4: Propagate from extraction** — in `rowsFromScheduleImage`, replace the final `return normalizeRows(parsed);` with:

```javascript
  const norm = normalizeRows(parsed);
  return { ...norm, scheduleCondition: summarize(norm.rows).scheduleCondition };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node test-schedule-select.js`
Expected: prints `Task 2 OK`, all prior `Task N OK` lines still print.

- [ ] **Step 6: Commit**

```bash
git add schedule-select.js test-schedule-select.js
git commit -m "feat(schedule): derive schedule-level rating condition"
```

---

## Task 3: Toshiba split honors on-coil conditions

**Files:**
- Modify: `schedule-select.js` — `matchSplit()` (lines ~52-64) and the split branch of `buildReply()` (lines ~196-218).
- Test: `test-schedule-select.js` (append block).

**Interfaces:**
- Consumes: `matchSplit(loadKw, famKey, cond, onCoil)` where `onCoil = {db, wb}` (°C) or `null`.
- Produces: `matchSplit(...)` return gains `usedOnCoil: boolean`. `buildReply` passes
  on-coil into `matchSplit` **only when `splitBrand === "toshiba"`** and the row has
  both `onCoilDb` and `onCoilWb`.

- [ ] **Step 1: Write the failing test** — append before the last `console.log` line:

```javascript
// --- Task 3: matchSplit accepts optional on-coil and flags usage ---
const stdSplit = S.matchSplit(5.0, "PKV", "T3");
assert.strictEqual(stdSplit.usedOnCoil, false);
const ocSplit = S.matchSplit(5.0, "PKV", "T3", { db: 27, wb: 19 });
assert.strictEqual(ocSplit.usedOnCoil, true);
assert.ok(ocSplit.capKw > 0);
// partial on-coil (wb missing) → treated as standard
const partial = S.matchSplit(5.0, "PKV", "T3", { db: 27, wb: null });
assert.strictEqual(partial.usedOnCoil, false);

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

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-schedule-select.js`
Expected: AssertionError on `stdSplit.usedOnCoil` (currently `undefined`).

- [ ] **Step 3: Update `matchSplit`** — replace the function:

```javascript
function matchSplit(loadKw, famKey, cond, onCoil = null) {
  if (!FAMILIES[famKey]) return null;
  const p = COND_POINTS[cond];
  const hasOC = !!(onCoil && onCoil.db != null && onCoil.wb != null);
  const idb = hasOC ? onCoil.db : p.idb;
  const iwb = hasOC ? onCoil.wb : p.iwb;
  const ranked = rankSplit(famKey, loadKw, idb, iwb, p.odb, cond, 0);
  if (!ranked.length) return null;
  const best = ranked[0]; // adequate-first, then smallest adequate
  return {
    label: best.label,
    capKw: best.tc,
    marginPct: Math.round((best.margin || 0) * 100),
    adequate: !!best.adequate,
    usedOnCoil: hasOC,
  };
}
```

- [ ] **Step 4: Pass on-coil from `buildReply`** — in the split-rows loop of `buildReply`, replace the `const m = matchSplit(...)` line and the final per-row push so Toshiba rows feed on-coil and the line tags it:

```javascript
      const oc = (splitBrand === "toshiba" && r.onCoilDb != null && r.onCoilWb != null)
        ? { db: r.onCoilDb, wb: r.onCoilWb } : null;
      const m = matchSplit(r.requiredKw, famKey, cond, oc);
      if (!m) {
        lines.push(`• ${r.location} — req ${capStr(r.requiredKw)} ×${r.qty}`,
          `   → ⚠️ ${brandTitle} ${r.category} — selection error, verify`);
        continue;
      }
      const flag = m.adequate ? "✅" : "⚠️ undersized";
      const kind = r.category === "ducted" ? "ducted" : "hi-wall";
      const ocTag = m.usedOnCoil ? ` · (on-coil ${r.onCoilDb}/${r.onCoilWb}°C from schedule)` : "";
      lines.push(`• ${r.location} (${kind}) — req ${capStr(r.requiredKw)} ×${r.qty}`,
        `   → ${m.label} · ${m.capKw.toFixed(1)} kW ${cond} · ${flag}${ocTag}`);
```

(Delete the old `const m = matchSplit(r.requiredKw, famKey, cond);` and the two lines that previously built `flag`/`kind`/the push, replacing them with the block above. Keep the `if (!famKey)` guard above it unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node test-schedule-select.js`
Expected: prints `Task 3 OK`; existing `matchSplit` asserts (lines 27-30) still pass.

- [ ] **Step 6: Commit**

```bash
git add schedule-select.js test-schedule-select.js
git commit -m "feat(schedule): Toshiba split honors schedule on-coil"
```

---

## Task 4: Trane MTZ on-coil + airflow validation

**Files:**
- Modify: `schedule-select.js` — add a `cToF` helper; `matchPackageTrane()` (lines ~94-101); the package Trane branch of `buildReply()` (lines ~178-184).
- Test: `test-schedule-select.js` (append block).

**Interfaces:**
- Consumes: `matchPackageTrane(loadKw, cond, onCoil, airflowCfm)` where `onCoil = {db, wb}` (°C) or `null`, `airflowCfm = number|null`.
- Produces: return gains `usedOnCoil: boolean`, `ratedCfm: number|null`, and
  `airflowWarn: { req, rated } | null` (set when `|req−rated|/rated > 0.15`).

- [ ] **Step 1: Write the failing test** — append before the last `console.log` line:

```javascript
// --- Task 4: Trane on-coil flag + airflow validation ---
const trStd = S.matchPackageTrane(30, "T3");
assert.strictEqual(trStd.usedOnCoil, false);
assert.ok(trStd.ratedCfm > 0);

const trOc = S.matchPackageTrane(30, "T3", { db: 27, wb: 19 });
assert.strictEqual(trOc.usedOnCoil, true);

// airflow far from rated → warn; near rated → no warn
const farCfm = Math.round(trStd.ratedCfm * 1.5);
const nearCfm = Math.round(trStd.ratedCfm * 1.05);
assert.ok(S.matchPackageTrane(30, "T3", null, farCfm).airflowWarn);
assert.strictEqual(S.matchPackageTrane(30, "T3", null, nearCfm).airflowWarn, null);

// --- Task 4: buildReply renders airflow + on-coil tags for Trane ---
const pRows = S.normalizeRows([
  { location: "AHU-1", type: "PACKAGE AC", capacity: 12, unit: "TR", qty: 1,
    onCoilDb: 27, onCoilWb: 19, airflow: 99999, airflowUnit: "CFM" },
]).rows;
const pReply = S.buildReply(pRows, [], { cond: "T3", pkgVendor: "trane" });
assert.match(pReply, /on-coil/i);
assert.match(pReply, /airflow/i);
console.log("Task 4 OK");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-schedule-select.js`
Expected: AssertionError on `trStd.usedOnCoil` (currently `undefined`).

- [ ] **Step 3: Add `cToF` and update `matchPackageTrane`** — add the helper after `toMbh`, then replace the function:

```javascript
function cToF(c) { return c * 9 / 5 + 32; }

// Trane MTZ package match. On-coil °C (if both present) → °F; else rated indoor
// 80/67°F assumed. Validates required airflow (CFM) against the model rated CFM.
function matchPackageTrane(loadKw, cond, onCoil = null, airflowCfm = null) {
  if (!COND_POINTS[cond]) throw new RangeError(`matchPackageTrane: unknown condition "${cond}"`);
  const reqTC = toMbh(loadKw);
  const amb = COND_POINTS[cond].ambF;
  const hasOC = !!(onCoil && onCoil.db != null && onCoil.wb != null);
  const db = hasOC ? cToF(onCoil.db) : 80;
  const wb = hasOC ? cToF(onCoil.wb) : 67;
  const ranked = rankModels(reqTC, 0, db, wb, amb);
  const best = ranked[0];
  const ratedCfm = best.fan && best.fan.cfm_rated ? best.fan.cfm_rated : null;
  let airflowWarn = null;
  if (airflowCfm != null && ratedCfm) {
    if (Math.abs(airflowCfm - ratedCfm) / ratedCfm > 0.15) {
      airflowWarn = { req: Math.round(airflowCfm), rated: ratedCfm };
    }
  }
  return { key: best.key, tons: best.tons, tcMbh: best.r.TC,
           adequate: !!best.adequate, usedOnCoil: hasOC, ratedCfm, airflowWarn };
}
```

- [ ] **Step 4: Render the tags in `buildReply`** — in the package-rows loop, replace the `if (pkgVendor === "trane") { ... }` block with:

```javascript
      if (pkgVendor === "trane") {
        const oc = (r.onCoilDb != null && r.onCoilWb != null)
          ? { db: r.onCoilDb, wb: r.onCoilWb } : null;
        const m = matchPackageTrane(r.requiredKw, cond, oc, r.airflow);
        const flag = m.adequate ? "✅" : "⚠️ undersized";
        const ocTag = m.usedOnCoil
          ? `(on-coil ${r.onCoilDb}/${r.onCoilWb}°C from schedule)` : "(rated indoor 80/67°F)";
        const air = r.airflow != null ? ` · airflow ${Math.round(r.airflow)} CFM` : "";
        lines.push(`• ${r.location} — req ${capStr(r.requiredKw)} ×${r.qty}${air}`,
          `   → MTZ ${m.key} · ${m.tons} TR · ${flag} _${ocTag}_`);
        if (m.airflowWarn) {
          lines.push(`   ⚠️ airflow off rated CFM (req ${m.airflowWarn.req} / rated ${m.airflowWarn.rated})`);
        }
      } else {
```

(The `else {` continues into the existing SKM branch — leave that branch body unchanged.)

- [ ] **Step 5: Export `cToF`** (optional but keeps tests flexible) — add `cToF` to `module.exports`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node test-schedule-select.js`
Expected: prints `Task 4 OK`; existing Trane asserts (lines 57-63) still pass.

- [ ] **Step 7: Commit**

```bash
git add schedule-select.js test-schedule-select.js
git commit -m "feat(schedule): Trane MTZ on-coil + airflow validation"
```

---

## Task 5: Skip the T1/T3 question when the schedule states the condition

**Files:**
- Modify: `server.js` — the `awaitImage` success block of `handleScheduleStep` (lines ~1302-1306).
- Test: manual smoke (the webhook is not covered by the unit-test script). A `node -e` import-sanity check guards against syntax errors.

**Interfaces:**
- Consumes: `extracted.scheduleCondition` from `rowsFromScheduleImage` (Task 2) and the existing `advanceScheduleQuestions(from, s)`.
- Produces: no new exports. When `scheduleCondition` is set, `s.cond` is filled and the `awaitCondition` step is skipped.

- [ ] **Step 1: Replace the post-extraction block** — in `handleScheduleStep`, replace these lines:

```javascript
    s.rows = extracted.rows;
    s.skipped = extracted.skipped;
    s.step = "awaitCondition";
    return await sendText(from,
      `I read *${extracted.rows.length}* rows.\n\n*Rate capacities at?*\n1. T1 (35°C)\n2. T3 (46°C)`);
```

with:

```javascript
    s.rows = extracted.rows;
    s.skipped = extracted.skipped;
    if (extracted.scheduleCondition) {
      s.cond = extracted.scheduleCondition;
      const label = s.cond === "T1" ? "T1 (35°C)" : "T3 (46°C)";
      await sendText(from,
        `I read *${extracted.rows.length}* rows. Detected rating *${label}* from the schedule.`);
      return await advanceScheduleQuestions(from, s);
    }
    s.step = "awaitCondition";
    return await sendText(from,
      `I read *${extracted.rows.length}* rows.\n\n*Rate capacities at?*\n1. T1 (35°C)\n2. T3 (46°C)`);
```

- [ ] **Step 2: Sanity-check that `server.js` still loads** (catches syntax errors without booting the server)

Run: `node -e "require('./schedule-select.js'); console.log('module OK')"`
Expected: prints `module OK`.

Run: `node --check server.js && echo "server.js syntax OK"`
Expected: prints `server.js syntax OK`.

- [ ] **Step 3: Manual smoke (live WhatsApp, optional but recommended)**

Follow the existing live smoke-test checklist in `docs/superpowers/plans/2026-06-17-schedule-image-selection-VERIFICATION.md`. Confirm three cases:
1. Schedule **with** a printed condition (e.g. header "@46°C" or a "T3" column) → bot says "Detected rating *T3 (46°C)*" and does **not** ask T1/T3.
2. Schedule **without** any condition → bot still asks "Rate capacities at? 1.T1 2.T3" as before.
3. A Toshiba split row with "ON COIL 27/19" and a Trane package row with an airflow value → reply shows the `(on-coil … from schedule)` tag and the `airflow … CFM` line.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(schedule): skip T1/T3 prompt when schedule states the condition"
```

---

## Self-Review

**Spec coverage:**
- Extract condition / on-coil / airflow / type → Task 1 (prompt + normalizeRows). ✅
- Auto-detect condition, ask only if absent → Task 2 (summarize.scheduleCondition) + Task 5 (server skip). ✅
- On-coil for Toshiba split only → Task 3 (`buildReply` gates on `splitBrand === "toshiba"`). ✅
- On-coil for Trane MTZ (°C→°F) → Task 4 (`cToF` + `matchPackageTrane`). ✅
- Airflow capture/display/validate ±15% → Task 4. ✅
- Split type → Hi-Wall default, honor ducted → already handled by existing `classifyCategory`/`splitFamilyKey`; `category` "split" ⇒ hi-wall family, "ducted" ⇒ ducted family. No code change needed; covered by existing asserts (lines 21-24) and the `kind` label in Task 3. ✅
- SKM package unchanged, TCL/SKM split standard → Tasks leave `matchPackageSkm` and non-Toshiba `matchSplit` calls passing `null` on-coil. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✅

**Type consistency:** `onCoil = {db, wb}` shape and the `usedOnCoil` / `ratedCfm` / `airflowWarn` return fields are used identically in Tasks 3-4 and consumed in `buildReply`. `scheduleCondition` produced in Task 2 is consumed in Task 5. `parseCondition`/`lsToCfm`/`cToF`/`numOrNull` helper names match between definition and use. ✅

**Note on test harness:** `test-schedule-select.js` is a linear assert script; each task appends a block ending in `console.log("Task N OK")`. Tasks must be implemented in order because later blocks depend on earlier module changes. The original final line `console.log("Task 6 OK")` stays last-but-one is not required — new blocks are appended after it.
