# Schedule Selection — On-Coil, Airflow & Condition-Aware Enhancements

**Date:** 2026-06-20
**Status:** Approved design, pending implementation plan
**Builds on:** `2026-06-17-schedule-image-selection-design.md` (already implemented)

## Problem

The schedule-image-selection feature already extracts an equipment schedule
(image/PDF), classifies rows as split/ducted/package, asks brand/vendor, and
selects matching Mannai units. It currently matches every row at **standard
rated indoor conditions** and **always asks T1/T3**, ignoring any conditions the
schedule itself prints. Consultants' schedules often state the rating condition,
the on-coil (entering-air) DB/WB, and (for package units) the required airflow.
We want the bot to honor those when present so the selection reflects the
schedule, not generic rating points.

This is an **enhancement** of the existing flow, not a rewrite. The trigger
keywords, session state machine, brand/vendor questions, APMR→APMR-A fallback,
SKM-package logic, and reply chunking are unchanged.

## Goals

- Extract, when printed: rating condition (T1/T3 or ambient), on-coil DB/WB,
  package airflow, and the explicit unit TYPE.
- Auto-detect the rating condition; only ask the user when it is not on the
  schedule.
- Pass schedule on-coil DB/WB into the engine for **Toshiba splits** and
  **Trane MTZ package** only; all other paths keep standard rated indoor.
- Capture, display, and validate package airflow against the selected MTZ
  model's rated CFM (no MTZ selection-logic change).
- Honor an explicit split TYPE (Hi-Wall vs Ducted); default to **Hi-Wall** when
  blank.
- Do not regress existing standard-condition selection or the VRF image flow.

## Non-Goals

- SKM package selection by nominal tonnage (stays capacity-at-condition).
- Driving MTZ fan ESP/CFM selection from required airflow (airflow is
  capture/display/validate only).
- On-coil for TCL split, SKM split, or SKM package (standard rated indoor).
- New split unit types (cassette / floor-standing) — catalogue is Hi-Wall +
  Ducted only.
- PDF export of results (text summary only, as today).

## Decisions (locked during brainstorming)

| Topic | Decision |
|---|---|
| T1/T3 source | Auto-detect from schedule; ask only if absent or rows conflict. |
| On-coil usage | Toshiba split **and** Trane MTZ package only; everything else standard. |
| SKM package | Unchanged — capacity-at-condition. |
| Airflow | Capture, display, validate vs rated CFM (±15% band). No engine rewrite. |
| Split type | Honor explicit TYPE → Hi-Wall vs Ducted; blank ⇒ Hi-Wall. |
| Ambient→condition | `35°C` (±a few °) ⇒ T1; `46°C` ⇒ T3. |

## Catalogue facts (grounding)

- Split families (`split-engine.js` FAMILIES): Toshiba `PKV` (Hi-Wall),
  `BSP` (Ducted non-inverter, current ducted default), `SH` (Ducted inverter);
  `TCL-HW` (Hi-Wall, no ducted); `SKM-HW` (Hi-Wall), `SKM-DCT` (Ducted).
- `rankSplit(famKey, loadKw, idb, iwb, odb, condition, tol)` already accepts
  indoor DB/WB (on-coil). The schedule flow currently passes fixed
  `COND_POINTS[cond].idb/iwb` (27/19 at T1, 29/19 at T3).
- `rankModels(reqTC, reqSC, db, wb, amb)` takes indoor DB/WB in **°F** and has
  **no airflow input**; it uses each model's rated fan CFM internally. The
  schedule flow currently passes assumed `80/67°F`.

## Data model — extracted row (additions)

`normalizeRows()` output row gains optional fields (all default to absent):

```
{
  ...existing: location, type, category, requiredKw, qty, srcValue, srcUnit,
  condition:  "T1" | "T3" | null,   // per-row, from explicit T1/T3 or ambient
  onCoilDb:   number | null,        // °C, entering-air dry-bulb to indoor coil
  onCoilWb:   number | null,        // °C, entering-air wet-bulb
  airflow:    number | null,        // package only, CFM (normalize L/s→CFM)
  airflowUnit:"CFM" | null,
  unitType:   "hiwall" | "ducted",  // resolved; blank TYPE ⇒ "hiwall"
}
```

Schedule-level condition is derived in `summarize()`:
`scheduleCondition = "T1" | "T3" | null` (non-null only if all
condition-bearing rows agree).

## Vision extraction changes

Extend `buildExtractionPrompt()` to request, **only when printed** (never
guessed):

- `condition`: explicit `T1`/`T3` token, or the outdoor ambient temperature
  (number + unit) if that is what the column/header states.
- `onCoilDb`, `onCoilWb`: entering-air conditions to the indoor coil (e.g.
  "ON COIL 27/19", "EAT 27°C DB / 19°C WB"). Numbers as printed, in °C.
- `airflow` + `airflowUnit`: for package rows (e.g. "CFM", "L/s").
- Keep TYPE cell verbatim (already captured) for type resolution.

Parsing rules in `normalizeRows()`:

- `condition`: `T1`/`T3` token wins; else map ambient — `≈35°C`→T1, `≈46°C`→T3;
  unrecognized ⇒ null (not a guess).
- On-coil: accept `DB/WB` pair forms; if only one value present, store it and
  leave the other null (engine fallback handles partials — see below).
- Airflow: if `L/s`, convert to CFM (`1 L/s = 2.11888 CFM`); store CFM.
- `unitType`: reuse existing `classifyCategory` signal — `ducted` keyword ⇒
  `ducted`; otherwise `hiwall`.

## Selection changes (`schedule-select.js`)

### Toshiba split — on-coil
When `splitBrand === "toshiba"` and a row has **both** `onCoilDb` and
`onCoilWb`, call `rankSplit(famKey, loadKw, onCoilDb, onCoilWb, odb, cond)`.
Otherwise use the standard `COND_POINTS[cond].idb/iwb`. Row output notes
`(on-coil 27/19 from schedule)` vs `(standard indoor)`.

TCL and SKM splits: always standard (`matchSplit` unchanged).

### Trane MTZ package — on-coil + airflow
- On-coil: when a row has both `onCoilDb`/`onCoilWb` (°C), convert to °F
  (`°F = °C×9/5+32`) and pass as `db`/`wb` to `rankModels`; else assume
  `80/67°F`. Tag `(on-coil from schedule)` vs `(rated indoor assumed)`.
- Airflow validation: after the model is chosen, read its rated CFM
  (`fanAt(key, rated_esp).cfm_rated`, already computed inside the engine —
  expose it on the result). If `airflow` present and
  `|req − rated| / rated > 0.15`, add `⚠️ airflow off rated CFM (req X / rated Y)`.

SKM package (`matchPackageSkm`): unchanged.

### Split type → family
`splitFamilyKey(brand, category)` already maps `ducted`→ducted family,
else hi-wall. Ensure a blank/unknown TYPE resolves to `hiwall`. Toshiba ducted
stays `BSP` (SH inverter variant is a future toggle, out of scope).

## Session flow change (`server.js`)

Only one change to `handleScheduleStep` / `advanceScheduleQuestions`:

- After extraction, if `extracted.scheduleCondition` is non-null, set
  `s.cond = scheduleCondition` and **skip** the `awaitCondition` step — go
  straight to `advanceScheduleQuestions`. Reply notes the detected condition,
  e.g. "Detected rating at *T3 (46°C)* from the schedule."
- If null, ask T1/T3 exactly as today.

No new steps, no new keywords, same 20-minute timeout, same `cancel`.

## Output format

Existing per-row format, with added inline tags:

```
🏢 PACKAGE (Trane MTZ)
• AHU-1 — req 12.0 TR (42.2 kW) ×1 · airflow 4500 CFM
   → MTZ ... · 12.5 TR · ✅ · (on-coil 27/19°C from schedule)
   ⚠️ airflow off rated CFM (req 4500 / rated 3800)

❄️ SPLIT (Toshiba)
• Office (hi-wall) — req 2.0 TR (7.0 kW) ×3
   → RAS-24PKV · ✅ · (on-coil 27/19 from schedule)
```

Header notes detected vs asked condition.

## Error handling

Unchanged from the existing feature. New fields are additive and optional; any
parse failure on a new field degrades to the standard-condition path for that
row (never drops the row). Capacity remains the only field whose unreadability
sends a row to the verify list.

## Testing

- **Extraction (fixtures):** schedules with/without printed condition; with/
  without on-coil; package with airflow in CFM and in L/s.
- **Condition inference:** `T1`/`T3` tokens; `35°C`→T1, `46°C`→T3; conflicting
  rows ⇒ null ⇒ ask.
- **Unit conversion:** on-coil °C→°F for MTZ; L/s→CFM.
- **Matching:** Toshiba split with custom on-coil vs standard picks the expected
  model at both conditions; MTZ with schedule on-coil vs assumed; airflow-off
  warning fires just outside ±15% and is silent just inside.
- **Type:** blank TYPE ⇒ hi-wall; explicit "ducted" ⇒ ducted family; TCL ducted
  ⇒ existing "not in catalogue" verify line.
- **Regression:** existing `test-schedule-select.js` stays green (standard
  paths unchanged); VRF image flow untouched.
