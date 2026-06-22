# Schedule Selection — Required vs Proposed summary

Date: 2026-06-22

## Problem

The Schedule Selection feature (image/PDF schedule upload → automated equipment
matching) already prints a Required/Proposed line per row in both outputs:

- the WhatsApp chat reply (`buildReply` in `schedule-select.js`)
- the PDF report (`generateSchedulePdf` in `schedule-pdf.js`)

But the fields shown are inconsistent across vendor paths:

- On-coil conditions are only shown for Trane MTZ packages and Toshiba splits.
  SKM/TCL splits and SKM packages show nothing, even when the schedule
  specifies on-coil DB/WB.
- The rating condition (T1/T3) used for the *match* is never printed for
  Trane rows.
- The schedule's own per-row condition/on-coil values (the "required" side)
  are parsed during extraction (`normalizeRows`) but never surfaced back to
  the user — they're consumed internally and discarded from the output.

Goal: every row in both outputs shows a consistent Required-vs-Proposed
comparison: capacity, condition (T1/T3), on-coil DB/WB, qty, and (on the
Proposed side) the model selected.

## Scope

Both outputs change together: `buildReply` (WhatsApp text) and
`generateSchedulePdf` (PDF table). They already share `computeSelections()`
as their single source of truth; this work keeps extending that pattern
rather than duplicating logic into two renderers.

## Per-row fields

| Field | Required (from schedule) | Proposed (from selection) |
|---|---|---|
| Capacity | `row.requiredKw` → TR/kW | `match.proposedKw` → TR/kW (already shown) |
| Condition (T1/T3) | `row.condition` if the schedule printed one, else **"not specified"** | the condition actually used to match (`cond` parameter) |
| On-coil DB/WB | `row.onCoilDb`/`row.onCoilWb` if *both* are printed, else **"not specified"** | the DB/WB actually assumed for that match (see below) — never the raw schedule value unless the engine genuinely used it |
| Qty | `row.qty` | `match.unitsNeeded` (already shown as "N× model") |
| Model | — | proposed model string (already shown) |

Required values always come straight from the row as extracted from the
schedule — no fallback computation, no invented numbers. If the schedule
didn't print it, the field reads "not specified."

## On-coil basis used for the Proposed side, per vendor path

The Proposed on-coil value must reflect what the matching engine actually
assumed, not just echo whatever was on the schedule — for engines that
don't consume on-coil at all, echoing the schedule value would misrepresent
the selection. Per vendor path:

- **Trane MTZ** (`matchPackageTrane`): schedule DB/WB when given
  (`usedOnCoil: true`), else the existing 80/67°F (26.7/19.4°C) rated
  default already hardcoded in the engine. Label accordingly: "(from
  schedule)" vs "(rated default)".
- **Toshiba split** (`matchSplit` with on-coil passed): schedule DB/WB when
  given, else `COND_POINTS[cond]` (27/19°C at T1, 29/19°C at T3) — the real
  rated point `rankSplit` evaluates at when no override is given.
- **SKM / TCL split** (`matchSplit`, no on-coil ever passed today): always
  `COND_POINTS[cond]`, labeled "(rated default)" — even when the schedule
  prints on-coil for that row, since non-Toshiba split matching doesn't
  consume it. Showing it as "from schedule" would be inaccurate.
- **SKM package** (`matchPackageSkm`): always 26.7°C/19.4°C (80/67°F),
  labeled "(rated default)" — the APMR/APMR-A capacity tables have no
  on-coil sensitivity or rated-point data anywhere in the codebase. This is
  a fixed display constant (matching the same standard rated indoor point
  Trane already uses), not derived from the schedule and not fed back into
  the capacity lookup.

## Rendering

### WhatsApp (compact inline)

Append condition + on-coil to the existing single-line Required/Proposed
entries:

```
• Office (hi-wall) — Required: 5.1 TR (18.0 kW) ×1 · T3 · On-coil: not specified
   → Proposed: PKV-18 · 18.5 kW · T3 · On-coil: 29/19°C (rated default) · ✅
```

```
• AHU-1 — Required: 12.0 TR (42.2 kW) ×1 · T3 · On-coil: 27/19°C
   → Proposed: MTZ 042 · 12.5 TR · T3 · On-coil: 27/19°C (from schedule) · ✅
```

Existing tags (multi-unit, airflow warning, fallback, error/verify) are
unchanged — condition/on-coil are additive to the line, not a replacement
of any existing content.

### PDF

The existing "Required" and "Proposed Selection" table columns become
multi-line composed strings: capacity on the first line (unchanged), then
condition and on-coil on following lines. Row height increases from the
current fixed 26pt to fit the extra lines (computed per-row from line
count, or a single larger fixed height — implementation detail). Columns,
totals row, and summary section are otherwise unchanged.

## Implementation shape

Add shared formatter functions in `schedule-select.js`:

- `formatRequiredBlock(row)` → the Required-side text (capacity, condition,
  on-coil, qty), used verbatim by both `buildReply` and the PDF's Required
  column.
- a Proposed-side on-coil formatter, parameterized by vendor/family + match
  + cond, producing the labeled on-coil string ("from schedule" / "rated
  default" / fixed SKM-package constant).

Match functions get small **additive** fields — no existing field is
renamed or removed, so all current assertions in `test-schedule-select.js`
keep passing:

- `matchSplit`: add the applied `idb`/`iwb` (already computed internally)
  and a `onCoilSource: "schedule" | "rated"` flag to the returned object.
- `matchPackageTrane`: already returns `db`/`wb` (°F) and `usedOnCoil`;
  add `onCoilSource` for consistent labeling with the other paths.
- `matchPackageSkm`: add a fixed-constant on-coil display value (26.7°C /
  19.4°C) — not a real input, purely for the Proposed-side label.

`buildReply` and `generateSchedulePdf` call the new shared formatters
instead of building ad hoc per-vendor strings inline.

## Testing

Extend `test-schedule-select.js` (next "Task N" block):

- `matchSplit` / `matchPackageTrane` expose the applied on-coil basis and
  source flag for both the schedule-given and rated-default cases.
- `matchPackageSkm` exposes the fixed display constant.
- `buildReply` renders Condition + On-coil for Required and Proposed across
  all four vendor paths (Trane, Toshiba split, SKM/TCL split, SKM package),
  including the "not specified" / "rated default" / "from schedule" labels.
- Existing assertions (exact match output for `unitsNeeded`, `proposedKw`,
  etc.) are unaffected since no existing field changes shape.

No test file exists yet for `schedule-pdf.js`; this work does not add one
(out of scope — PDF byte-level testing isn't part of this codebase's
existing conventions). The PDF change is verified manually by generating a
sample report.
