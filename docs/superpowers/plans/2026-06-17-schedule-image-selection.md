# Schedule Image Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a WhatsApp user send an equipment-schedule image/PDF and have the bot extract each row, classify it as package or hi-wall/ducted split, and select the matching Mannai unit (APMR / APMR-A / Trane MTZ for package; Toshiba / TCL / SKM for splits).

**Architecture:** A new self-contained `schedule-select.js` module owns the vision-extraction prompt, unit normalization, classification, and capacity matching (pure functions, no I/O except the one vision fetch). A small `scheduleSessions` state machine in `server.js` mirrors the existing `vrfSessions` wiring: keyword → image download → ask rating condition → ask brand(s) → produce a per-row reply. The module reuses `split-engine.rankSplit`, `products.js` `PRODUCTS`, `mtz-engine.rankModels`, and the existing `vrf/vrfIntake.capacityToKw` converter.

**Tech Stack:** Node.js, Express, Anthropic Messages API (vision), plain `node:assert` test scripts (repo convention — no test framework installed; run with `node test-*.js`).

---

## Reference facts (verified against the codebase)

- Split families (`split-engine.js` `FAMILIES` / `FAMILY_MENU`): `PKV` (Toshiba hi-wall), `BSP` (Toshiba ducted non-inverter), `SH` (Toshiba ducted inverter), `TCL-HW` (TCL hi-wall), `SKM-HW` (SKM hi-wall), `SKM-DCT` (SKM ducted). TCL has **no** ducted family.
- `rankSplit(famKey, loadKw, idb, iwb, odb, condition="T3", tol=0)` returns an array sorted adequate-first; each item: `{ key, label, tc, eer, margin, adequate, ... }`. Standard indoor points: T1 `{idb:27,iwb:19,odb:35}`, T3 `{idb:29,iwb:19,odb:46}`.
- `PRODUCTS` (`products.js`, exported): keys `"apmr"` (15 models, T3 kW 13.9–87.6) and `"apmr-a"` (25 models, T3 kW 13.6–282.2). Each model: `{ code, cfm, t1_kw, t3_kw }`.
- `rankModels(reqTC, reqSC, db, wb, amb)` (`mtz-engine.js`, exported) returns array sorted adequate-first; each item: `{ key, tons, r:{TC,SC,...}, adequate, ... }`. `reqTC`/`reqSC` are in **MBH** (thousand BTU/h); pass `reqSC = 0` to ignore sensible.
- `capacityToKw(value, unitHint)` exported from `vrf/vrfIntake.js` — converts kW/TR/ton/BTU/h/MBH/kcal/h to kW. Returns `{ kw, unit }`.
- `server.js` webhook: `downloadWhatsAppMedia(mediaId)` → `{ buffer, mediaType }`. `vrfSessions` block sits at ~line 1658; `if (message.type !== "text") return;` is at ~line 1694. New image-accepting blocks must go **before** that guard. `sendText`, `sendButtons`, `sendLongText` are in `server.js` scope.

## File structure

- **Create** `schedule-select.js` — pure module: constants, `classifyCategory`, `splitFamilyKey`, `matchSplit`, `matchPackageSkm`, `matchPackageTrane`, `buildExtractionPrompt`, `normalizeRows`, `summarize`, `buildReply`, and the single network function `rowsFromScheduleImage`.
- **Create** `test-schedule-select.js` — `node:assert` test script, grown task-by-task.
- **Modify** `server.js` — require the module; add `scheduleSessions` Map + `SCHEDULE_TIMEOUT_MS`; add trigger + session handler blocks before the `message.type !== "text"` guard.
- **Modify** `docs/superpowers/specs/2026-06-17-schedule-image-selection-design.md` — only if an implementation detail diverges (keep spec and plan in sync).

## Module choices locked here (open for user override)

- Toshiba **ducted** default family = `BSP` (non-inverter). `SPLIT_FAMILY.toshiba.ducted = "BSP"`.
- TCL **ducted** = unsupported → such a row is reported in the "⚠️ verify" list with reason "TCL ducted not in catalogue".
- Trane package indoor rated point assumed `DB 80°F / WB 67°F`; ambient from condition (`T1→95°F`, `T3→115°F`).

---

### Task 1: Module scaffold — constants, unit normalization, classification

**Files:**
- Create: `schedule-select.js`
- Test: `test-schedule-select.js`

- [ ] **Step 1: Write the failing test**

Create `test-schedule-select.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-schedule-select.js`
Expected: FAIL with "Cannot find module './schedule-select.js'".

- [ ] **Step 3: Write minimal implementation**

Create `schedule-select.js`:

```js
// Schedule Image Selection — pure selection logic for the WhatsApp bot.
// Extracts an equipment schedule (image/PDF) into rows, classifies each row,
// and matches Mannai units by capacity. No state; the server owns sessions.

const { rankSplit, FAMILIES } = require("./split-engine.js");
const { PRODUCTS } = require("./products.js");
const { rankModels } = require("./mtz-engine.js");
const { capacityToKw } = require("./vrf/vrfIntake.js");

const KW_PER_TR = 3.51685;
const MBH_PER_KW = 3.412142;

// Outdoor/indoor rating points + Fahrenheit ambient per condition.
const COND_POINTS = {
  T1: { idb: 27, iwb: 19, odb: 35, ambF: 95 },
  T3: { idb: 29, iwb: 19, odb: 46, ambF: 115 },
};

// brand -> { hiwall, ducted } family keys. null = unsupported.
const SPLIT_FAMILY = {
  toshiba: { hiwall: "PKV", ducted: "BSP" },
  tcl: { hiwall: "TCL-HW", ducted: null },
  skm: { hiwall: "SKM-HW", ducted: "SKM-DCT" },
};

function toKw(value, unitHint) {
  const conv = capacityToKw(parseFloat(value), `${unitHint || ""} ${value}`);
  return conv.kw;
}
function toTr(kw) { return kw / KW_PER_TR; }
function toMbh(kw) { return kw * MBH_PER_KW; }

// Map a free-text TYPE cell to a category enum. package > ducted > split.
function classifyCategory(text) {
  const t = String(text || "").toLowerCase();
  if (/package|floor\s*stand|roof\s*top|rooftop|packaged/.test(t)) return "package";
  if (/duct/.test(t)) return "ducted";
  if (/split|hi[\s-]?wall|high[\s-]?wall|wall|cassette/.test(t)) return "split";
  return null;
}

module.exports = {
  KW_PER_TR, MBH_PER_KW, COND_POINTS, SPLIT_FAMILY,
  toKw, toTr, toMbh, classifyCategory,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-schedule-select.js`
Expected: prints `Task 1 OK`.

- [ ] **Step 5: Commit**

```bash
git add schedule-select.js test-schedule-select.js
git commit -m "feat(schedule): module scaffold — unit conversion + classification"
```

---

### Task 2: Split matching

**Files:**
- Modify: `schedule-select.js`
- Test: `test-schedule-select.js`

- [ ] **Step 1: Write the failing test**

Append to `test-schedule-select.js` (above the final `console.log`, and update the final log to `Task 2 OK`):

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-schedule-select.js`
Expected: FAIL — `S.splitFamilyKey is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `schedule-select.js`, add before `module.exports` and export the two new names:

```js
function splitFamilyKey(brand, category) {
  const b = SPLIT_FAMILY[String(brand || "").toLowerCase()];
  if (!b) return null;
  return category === "ducted" ? b.ducted : b.hiwall;
}

// Match a load (kW) against a split family at the given condition.
// Returns { label, capKw, marginPct, adequate } or null if family unknown.
function matchSplit(loadKw, famKey, cond) {
  if (!FAMILIES[famKey]) return null;
  const p = COND_POINTS[cond];
  const ranked = rankSplit(famKey, loadKw, p.idb, p.iwb, p.odb, cond, 0);
  if (!ranked.length) return null;
  const best = ranked[0]; // adequate-first, then smallest adequate
  return {
    label: best.label,
    capKw: best.tc,
    marginPct: Math.round((best.margin || 0) * 100),
    adequate: !!best.adequate,
  };
}
```

Add `splitFamilyKey, matchSplit` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-schedule-select.js`
Expected: prints `Task 2 OK`.

- [ ] **Step 5: Commit**

```bash
git add schedule-select.js test-schedule-select.js
git commit -m "feat(schedule): split matching via rankSplit"
```

---

### Task 3: Package matching (APMR/APMR-A fallback + Trane)

**Files:**
- Modify: `schedule-select.js`
- Test: `test-schedule-select.js`

- [ ] **Step 1: Write the failing test**

Append (update final log to `Task 3 OK`):

```js
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

// --- Trane ---
const tr = S.matchPackageTrane(30, "T3");
assert.ok(tr && typeof tr.key === "string");
assert.ok(tr.tcMbh > 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-schedule-select.js`
Expected: FAIL — `S.matchPackageSkm is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `schedule-select.js` and export:

```js
// SKM package match against APMR, with auto fall-back to APMR-A when the load
// exceeds the APMR range. seriesKey is "apmr" or "apmr-a".
function matchPackageSkm(loadKw, seriesKey, cond) {
  const field = cond === "T1" ? "t1_kw" : "t3_kw";
  const pick = (key) => {
    const models = [...PRODUCTS[key].models].sort((a, b) => a[field] - b[field]);
    const m = models.find((x) => x[field] >= loadKw);
    return m ? { code: m.code, capKw: m[field] } : null;
  };
  let series = seriesKey;
  let hit = pick(seriesKey);
  let fellBack = false;
  if (!hit && seriesKey === "apmr") {
    const a = pick("apmr-a");
    if (a) { series = "apmr-a"; hit = a; fellBack = true; }
  }
  if (!hit) {
    const models = [...PRODUCTS[series].models].sort((a, b) => a[field] - b[field]);
    const max = models[models.length - 1];
    return { series, code: max.code, capKw: max[field], adequate: false, fellBack };
  }
  return { series, code: hit.code, capKw: hit.capKw, adequate: true, fellBack };
}

// Trane MTZ package match. Indoor rated DB80/WB67 assumed; ambient from cond.
function matchPackageTrane(loadKw, cond) {
  const reqTC = toMbh(loadKw);
  const amb = COND_POINTS[cond].ambF;
  const ranked = rankModels(reqTC, 0, 80, 67, amb);
  const best = ranked[0];
  return { key: best.key, tons: best.tons, tcMbh: best.r.TC, adequate: !!best.adequate };
}
```

Add `matchPackageSkm, matchPackageTrane` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-schedule-select.js`
Expected: prints `Task 3 OK`.

- [ ] **Step 5: Commit**

```bash
git add schedule-select.js test-schedule-select.js
git commit -m "feat(schedule): package matching (APMR/APMR-A fallback + Trane)"
```

---

### Task 4: Extraction prompt + row normalization

**Files:**
- Modify: `schedule-select.js`
- Test: `test-schedule-select.js`

- [ ] **Step 1: Write the failing test**

Append (update final log to `Task 4 OK`):

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-schedule-select.js`
Expected: FAIL — `S.buildExtractionPrompt is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `schedule-select.js` and export:

```js
function buildExtractionPrompt() {
  return [
    "You are extracting an HVAC equipment / AC unit schedule. Return ONLY a JSON",
    "array, no prose, no markdown fences. Each element:",
    '{"location": <room/area/tag text or "">,',
    ' "type": <the TYPE cell text exactly as written, e.g. "SPLIT", "PACKAGE AC", "DUCTED">,',
    ' "category": <"split" | "ducted" | "package" — your best read of the unit kind>,',
    ' "capacity": <the SPECIFIED/REQUIRED cooling capacity NUMBER exactly as printed>,',
    ' "unit": <capacity unit EXACTLY as printed: "kW","TR","ton","BTU/HR","MBH","kcal/h"; "" if none>,',
    ' "qty": <integer, default 1>}',
    "Use the SPECIFIED/required capacity, not any competitor 'offered' column.",
    "If the table heading says the units are splits, treat rows as split unless a",
    "row says ducted. Copy the capacity value and unit EXACTLY; do NOT convert.",
    "A cell like '48,000x8' means capacity 48000 and qty 8. Do not invent rows. If",
    "you cannot confidently read a capacity, OMIT that row. Return [] if no schedule.",
  ].join(" ");
}

// Vision JSON -> { rows, skipped }. rows are normalized + classified; skipped
// holds rows we could not read (bad capacity or unknown category).
function normalizeRows(rawArray) {
  const rows = [];
  const skipped = [];
  for (const r of Array.isArray(rawArray) ? rawArray : []) {
    if (!r) continue;
    const category = classifyCategory(r.category || r.type);
    const value = parseFloat(r.capacity);
    if (!category || isNaN(value)) {
      skipped.push({ location: String(r.location || ""), raw: r.type || r.capacity || "" });
      continue;
    }
    const requiredKw = toKw(value, r.unit);
    if (isNaN(requiredKw)) {
      skipped.push({ location: String(r.location || ""), raw: `${r.capacity} ${r.unit || ""}` });
      continue;
    }
    rows.push({
      location: String(r.location || ""),
      type: String(r.type || ""),
      category,
      requiredKw,
      qty: parseInt(r.qty, 10) || 1,
      srcValue: value,
      srcUnit: String(r.unit || ""),
    });
  }
  return { rows, skipped };
}
```

Add `buildExtractionPrompt, normalizeRows` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-schedule-select.js`
Expected: prints `Task 4 OK`.

- [ ] **Step 5: Commit**

```bash
git add schedule-select.js test-schedule-select.js
git commit -m "feat(schedule): extraction prompt + row normalization"
```

---

### Task 5: Summary + reply formatter

**Files:**
- Modify: `schedule-select.js`
- Test: `test-schedule-select.js`

- [ ] **Step 1: Write the failing test**

Append (update final log to `Task 5 OK`):

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-schedule-select.js`
Expected: FAIL — `S.summarize is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `schedule-select.js` and export:

```js
function summarize(rows) {
  return {
    count: rows.length,
    hasSplit: rows.some((r) => r.category === "split" || r.category === "ducted"),
    hasPackage: rows.some((r) => r.category === "package"),
  };
}

function capStr(kw) {
  return `${toTr(kw).toFixed(1)} TR (${kw.toFixed(1)} kW)`;
}

// Build the final WhatsApp reply. choices: { cond, splitBrand, pkgVendor,
// pkgSeries }. skipped is the verify list from normalizeRows.
function buildReply(rows, skipped, choices) {
  const { cond, splitBrand, pkgVendor, pkgSeries } = choices;
  const lines = [`📋 *Schedule Selection* — ${rows.length} rows · rated at ${cond}`];

  const pkgRows = rows.filter((r) => r.category === "package");
  const splitRows = rows.filter((r) => r.category === "split" || r.category === "ducted");

  if (pkgRows.length) {
    const vendorLabel = pkgVendor === "trane" ? "Trane MTZ"
      : `SKM ${pkgSeries === "apmr-a" ? "APMR-A" : "APMR"}`;
    lines.push("", `🏢 *PACKAGE (${vendorLabel})*`);
    for (const r of pkgRows) {
      if (pkgVendor === "trane") {
        const m = matchPackageTrane(r.requiredKw, cond);
        const flag = m.adequate ? "✅" : "⚠️ undersized";
        lines.push(`• ${r.location} — req ${capStr(r.requiredKw)} ×${r.qty}`,
          `   → MTZ ${m.key} · ${m.tons} TR · ${flag} _(rated indoor 80/67°F)_`);
      } else {
        const m = matchPackageSkm(r.requiredKw, pkgSeries, cond);
        const name = `${m.series === "apmr-a" ? "APMR-A" : "APMR"} ${m.code}`;
        const tags = [];
        if (m.fellBack) tags.push("↪ APMR-A (APMR range exceeded)");
        tags.push(m.adequate ? "✅" : "⚠️ undersized");
        lines.push(`• ${r.location} — req ${capStr(r.requiredKw)} ×${r.qty}`,
          `   → ${name} · ${m.capKw.toFixed(1)} kW ${cond} · ${tags.join(" · ")}`);
      }
    }
  }

  if (splitRows.length) {
    const brandTitle = splitBrand.charAt(0).toUpperCase() + splitBrand.slice(1);
    lines.push("", `❄️ *SPLIT (${brandTitle})*`);
    for (const r of splitRows) {
      const famKey = splitFamilyKey(splitBrand, r.category);
      if (!famKey) {
        lines.push(`• ${r.location} — req ${capStr(r.requiredKw)} ×${r.qty}`,
          `   → ⚠️ ${brandTitle} ${r.category} not in catalogue — verify`);
        continue;
      }
      const m = matchSplit(r.requiredKw, famKey, cond);
      const flag = m.adequate ? "✅" : "⚠️ undersized";
      const kind = r.category === "ducted" ? "ducted" : "hi-wall";
      lines.push(`• ${r.location} (${kind}) — req ${capStr(r.requiredKw)} ×${r.qty}`,
        `   → ${m.label} · ${m.capKw.toFixed(1)} kW ${cond} · ${flag}`);
    }
  }

  if (skipped && skipped.length) {
    lines.push("", `⚠️ *Verify: ${skipped.length} row(s) couldn't be read*`);
    for (const s of skipped) lines.push(`• ${s.location || s.raw || "(unreadable)"}`);
  }
  return lines.join("\n");
}
```

Add `summarize, buildReply` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-schedule-select.js`
Expected: prints `Task 5 OK`.

- [ ] **Step 5: Commit**

```bash
git add schedule-select.js test-schedule-select.js
git commit -m "feat(schedule): summary + reply formatter"
```

---

### Task 6: Vision API wrapper

**Files:**
- Modify: `schedule-select.js`
- Test: `test-schedule-select.js`

The network call mirrors `vrf/vrfIntake.rowsFromImageOrPdf`. It is not unit-tested
(needs the API); the test only asserts the function exists and is async.

- [ ] **Step 1: Write the failing test**

Append (update final log to `Task 6 OK`):

```js
// --- rowsFromScheduleImage exists and is async ---
assert.strictEqual(typeof S.rowsFromScheduleImage, "function");
assert.strictEqual(S.rowsFromScheduleImage.constructor.name, "AsyncFunction");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-schedule-select.js`
Expected: FAIL — `typeof S.rowsFromScheduleImage` is `"undefined"`.

- [ ] **Step 3: Write minimal implementation**

Add to `schedule-select.js` and export. Place `const EXTRACT_MODEL = ...` near the top consts:

```js
const EXTRACT_MODEL = process.env.SCHEDULE_EXTRACT_MODEL || "claude-sonnet-4-6";

// Send an image/PDF to Claude vision and return normalized { rows, skipped }.
async function rowsFromScheduleImage(base64Data, mediaType) {
  const isPdf = mediaType === "application/pdf";
  const block = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: EXTRACT_MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content: [block, { type: "text", text: buildExtractionPrompt() }] }],
    }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch (_) {}
    throw new Error(`schedule extraction API ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text").map((b) => b.text).join("")
    .replace(/```json|```/g, "").trim();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (_) { throw new Error("Could not parse the schedule. Try a clearer photo or PDF."); }
  return normalizeRows(parsed);
}
```

Add `rowsFromScheduleImage` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-schedule-select.js`
Expected: prints `Task 6 OK`.

- [ ] **Step 5: Commit**

```bash
git add schedule-select.js test-schedule-select.js
git commit -m "feat(schedule): vision extraction API wrapper"
```

---

### Task 7: Wire the session into server.js

**Files:**
- Modify: `server.js` (require near other requires ~line 13–25; state near `pendingSplit` ~line 125; trigger + handler blocks before `if (message.type !== "text") return;` ~line 1694)

- [ ] **Step 1: Add the require and session state**

After the existing `require("./products.js")` line group (~line 13), add:

```js
const schedule = require("./schedule-select.js");
```

Near `const pendingSplit = {};` (~line 129), add:

```js
const scheduleSessions = new Map(); // from -> { step, ts, rows, skipped, cond, splitBrand, pkgVendor }
const SCHEDULE_TIMEOUT_MS = 10 * 60 * 1000;
```

- [ ] **Step 2: Add the trigger + session handler**

Immediately **before** the line `if (message.type !== "text") return;` (~line 1694), insert:

```js
// ── Schedule / BOQ image selection ───────────────────────────
// Trigger: exact "Image Selection" / "BOQ Selection" / "Schedule Selection".
if (message.type === "text" &&
    /^(image|boq|schedule)\s+selection$/i.test(message.text.body.trim())) {
  scheduleSessions.set(from, { step: "awaitImage", ts: Date.now() });
  return await sendText(from,
    "📋 *Schedule / BOQ Selection*\n\nSend the equipment schedule as an *image* or *PDF*.\n_(Type *cancel* anytime to exit)_");
}

if (scheduleSessions.has(from)) {
  const s = scheduleSessions.get(from);
  if (Date.now() - (s.ts || 0) > SCHEDULE_TIMEOUT_MS) {
    scheduleSessions.delete(from);
    return await sendText(from, "⏰ Schedule session timed out. Type *Schedule Selection* to start again.");
  }
  s.ts = Date.now();
  const vText = message.type === "text" ? message.text.body.trim() : "";
  if (/^cancel$/i.test(vText)) {
    scheduleSessions.delete(from);
    return await sendText(from, "✅ Schedule selection cancelled.");
  }
  return await handleScheduleStep(from, s, message, vText);
}
```

- [ ] **Step 3: Add the `handleScheduleStep` function**

Add this function in `server.js` near the other `handle*Step` functions (e.g. after `handleSplitStep`). It drives the state machine: `awaitImage → awaitCondition → awaitSplitBrand → awaitPkgVendor → done`.

```js
async function handleScheduleStep(from, s, message, vText) {
  // 1) Waiting for the image/PDF.
  if (s.step === "awaitImage") {
    let media = null;
    if (message.type === "image" && message.image?.id) media = message.image.id;
    else if (message.type === "document" && message.document?.id) media = message.document.id;
    if (!media) return await sendText(from, "Please send the schedule as an *image* or *PDF*.");

    let dl;
    try { dl = await downloadWhatsAppMedia(media); }
    catch (err) {
      console.error("❌ Schedule media download error:", err.response?.data || err.message);
      return await sendText(from, "I couldn't download that file. Try again, or send a clearer photo.");
    }
    const mediaType = message.type === "document"
      ? (message.document.mime_type || dl.mediaType) : dl.mediaType;

    await sendText(from, "🔍 Reading the schedule, one moment…");
    let extracted;
    try { extracted = await schedule.rowsFromScheduleImage(dl.buffer.toString("base64"), mediaType); }
    catch (err) {
      console.error("❌ Schedule extraction error:", err.message);
      return await sendText(from, "Sorry, I couldn't read that schedule. Try a clearer image or a PDF.");
    }
    if (!extracted.rows.length) {
      scheduleSessions.delete(from);
      return await sendText(from, "I didn't find any schedule rows. Please resend a clearer image.");
    }
    s.rows = extracted.rows;
    s.skipped = extracted.skipped;
    s.step = "awaitCondition";
    return await sendText(from,
      `I read *${extracted.rows.length}* rows.\n\n*Rate capacities at?*\n1. T1 (35°C)\n2. T3 (46°C)`);
  }

  // 2) Rating condition.
  if (s.step === "awaitCondition") {
    if (vText === "1") s.cond = "T1";
    else if (vText === "2") s.cond = "T3";
    else return await sendText(from, "Reply *1* for T1 (35°C) or *2* for T3 (46°C).");
    return await advanceScheduleQuestions(from, s);
  }

  // 3) Split brand.
  if (s.step === "awaitSplitBrand") {
    const map = { "1": "toshiba", "2": "tcl", "3": "skm" };
    if (!map[vText]) return await sendText(from, "Reply *1* Toshiba, *2* TCL, or *3* SKM.");
    s.splitBrand = map[vText];
    return await advanceScheduleQuestions(from, s);
  }

  // 4) Package vendor.
  if (s.step === "awaitPkgVendor") {
    if (vText === "1") { s.pkgVendor = "skm"; s.step = "awaitPkgSeries";
      return await sendText(from, "*APMR or APMR-A?*\n1. APMR\n2. APMR-A"); }
    if (vText === "2") { s.pkgVendor = "trane"; s.pkgSeries = null;
      return await advanceScheduleQuestions(from, s); }
    return await sendText(from, "Reply *1* SKM or *2* Trane.");
  }

  // 5) Package SKM series.
  if (s.step === "awaitPkgSeries") {
    if (vText === "1") s.pkgSeries = "apmr";
    else if (vText === "2") s.pkgSeries = "apmr-a";
    else return await sendText(from, "Reply *1* APMR or *2* APMR-A.");
    return await advanceScheduleQuestions(from, s);
  }
}

// Ask the next needed question, or produce the result when all answered.
async function advanceScheduleQuestions(from, s) {
  const sum = schedule.summarize(s.rows);
  if (sum.hasSplit && !s.splitBrand) {
    s.step = "awaitSplitBrand";
    return await sendText(from, "*Which split brand?*\n1. Toshiba\n2. TCL\n3. SKM");
  }
  if (sum.hasPackage && !s.pkgVendor) {
    s.step = "awaitPkgVendor";
    return await sendText(from, "*Package line?*\n1. SKM (APMR)\n2. Trane (MTZ)");
  }
  const reply = schedule.buildReply(s.rows, s.skipped, {
    cond: s.cond, splitBrand: s.splitBrand, pkgVendor: s.pkgVendor, pkgSeries: s.pkgSeries,
  });
  scheduleSessions.delete(from);
  return await sendLongText(from, reply);
}
```

- [ ] **Step 4: Verify the server boots**

Run: `node -e "require('./server.js')" ` is not safe (starts listening). Instead syntax-check:
Run: `node --check server.js`
Expected: no output (exit 0). Then `node --check schedule-select.js` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(schedule): wire session state machine into webhook"
```

---

### Task 8: End-to-end manual verification + docs

**Files:**
- Modify: `docs/superpowers/specs/2026-06-17-schedule-image-selection-design.md` (only if reality diverged)

- [ ] **Step 1: Full unit-test pass**

Run: `node test-schedule-select.js`
Expected: prints `Task 5 OK` (final marker) with no assertion errors.

- [ ] **Step 2: Live smoke test (requires running bot + WhatsApp)**

Deploy/run the bot. From a WhatsApp number that has messaged the bot recently:
1. Send `Schedule Selection`. Expect the "send the schedule" prompt.
2. Send the sample Midea mosque schedule image.
3. Expect "I read N rows" → "Rate at T1/T3?". Reply `2`.
4. Expect "Which split brand?" (schedule has splits). Reply `1` (Toshiba).
5. Expect "Package line?". Reply `1` then `1` (SKM → APMR).
6. Verify the reply lists package rows as APMR models and split rows as Toshiba
   models, capacities shown in TR + kW, with a verify list if any row was skipped.

- [ ] **Step 3: Record the result**

If any step behaved differently from the spec, fix the code (re-running Task's
tests) or update the spec doc to match the shipped behaviour. Note the model
numbers the bot returned for 2–3 rows so a regression is detectable later.

- [ ] **Step 4: Commit any doc/code adjustments**

```bash
git add -p   # stage only intended files (never -A; repo has untracked secrets)
git commit -m "test(schedule): end-to-end verification notes + fixes"
```

---

## Self-review

- **Spec coverage:** triggers (Task 7) ✓; ask T1/T3 (Task 7) ✓; vision extraction with unit detection (Tasks 4, 6) ✓; normalize to kW + display TR/kW (Tasks 1, 5) ✓; classify package/split/ducted (Task 1) ✓; split brand once (Task 7) ✓; SKM APMR/APMR-A with fallback + Trane (Tasks 3, 5) ✓; per-row output + verify list (Task 5) ✓; T1/T3 matching (Tasks 2, 3) ✓; error handling (Task 7) ✓; tests (every task) ✓.
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** `matchSplit` → `{label,capKw,marginPct,adequate}`; `matchPackageSkm` → `{series,code,capKw,adequate,fellBack}`; `matchPackageTrane` → `{key,tons,tcMbh,adequate}`; `normalizeRows` → `{rows:[{location,type,category,requiredKw,qty,srcValue,srcUnit}], skipped:[{location,raw}]}`; `buildReply(rows, skipped, {cond,splitBrand,pkgVendor,pkgSeries})`. All consistent across tasks 2–7.
