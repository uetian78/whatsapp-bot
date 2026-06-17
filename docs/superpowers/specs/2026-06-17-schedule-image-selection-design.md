# Schedule Image Selection — Design

**Date:** 2026-06-17
**Status:** Approved design, pending implementation plan

## Problem

Consultants share an equipment / AC unit schedule as an image (or PDF). Today the
WhatsApp bot only extracts schedules inside a VRF session; package and hi-wall
split rows are not handled. We want a user to send any such schedule and have the
bot extract each row's required cooling capacity, classify it as package or split,
and select the matching Mannai unit from the bot's own catalogue.

The bot re-selects from Mannai's range using the consultant's **specified/required
capacity**. It does not trust the competitor's "offered" column.

## Goals

- New keyword-triggered flow that accepts an image/PDF schedule.
- Extract rows: location, category (split/ducted/package), required capacity, qty.
- Normalize whatever capacity unit the schedule uses (BTU/hr, kW, TR, MBH) to kW.
- Select the matching Mannai unit per row and return a readable per-row summary.
- Do not regress the existing VRF image flow.

## Non-Goals (v1)

- PDF export of the result (text summary only; PDF is a follow-up, reusing the
  existing split-pdf / mtz-pdf style).
- Cross-referencing the competitor's offered model.
- Multi-image / multi-page stitching beyond what a single message provides.

## Architecture

**Approach A (chosen): self-contained module + thin session handler.**

- `schedule-select.js` — new module. Owns the vision extraction prompt, unit
  normalization, and the matching logic. Pure-ish: takes extracted rows + brand
  choices, returns selection results. Reuses `split-engine.rankSplit` and the
  `products.js` APMR / APMR-A data. No coupling to the VRF module.
- `server.js` — small `scheduleSessions` block mirroring the existing
  `vrfSessions` wiring (download media via `downloadWhatsAppMedia`, 20-minute
  timeout, exact-keyword trigger).

Rejected: extending the VRF intake (couples to and risks the working VRF feature);
inlining in `server.js` (already ~2100 lines, hard to test).

## Trigger & session flow

1. Exact keyword **`Schedule Selection`** → bot: "📋 Send the equipment schedule as
   an image or PDF."
2. User sends image/PDF → `downloadWhatsAppMedia` → vision extraction.
3. Bot asks only the brand questions that apply to the rows found:
   - Split rows present → "Which split brand? 1.Toshiba 2.TCL 3.SKM" (once, applies
     to all split rows).
   - Package rows present → "Package line? 1.SKM 2.Trane" → if SKM → "1.APMR
     2.APMR-A".
4. Bot returns the per-row selection summary.
5. 20-minute session timeout (same as VRF). `cancel` exits.

## Vision extraction

Claude vision returns structured JSON rows — only what is on the schedule, nothing
fabricated:

```
{ location, category, mounting, capacity: { value, unit }, qty, raw }
```

- `category`: `split` | `ducted` | `package`, derived from the TYPE column. A table
  heading of "splits" defaults rows to hi-wall split; "ducted" → ducted split;
  "package"/"floor stand" → package.
- `capacity.value` + `capacity.unit`: the **specified/required** capacity and its
  unit, read from the column header (e.g. "...CAPACITY (BTU/HR @46 DEG)") or a
  per-cell suffix (`50TR`, `17.6 kW`). The `@46°` basis corresponds to T3.
- `qty`: parsed from a `48,000×8` style cell or the QTY column.
- `raw`: the original cell text, retained for the audit trail in the output.

Rows that cannot be parsed (bare number with no detectable unit, unreadable cell)
are collected into a "⚠️ verify" list rather than guessed.

## Unit normalization

Canonical unit for matching is **kW**. Conversions:

- `1 TR = 3.51685 kW = 12,000 BTU/hr`
- `1 kW = 3412.14 BTU/hr`
- `1 MBH = 1000 BTU/hr`

Output displays both **kW and TR** so the line reads naturally regardless of the
source unit, e.g. `req 4.0 TR (14.1 kW)`.

## Matching rules

All capacity comparisons use the **T3 (46°C)** rating, matching the schedule basis.

- **Split / ducted**: `rankSplit(famKey, loadKw, 29, 19, 46, "T3")` on the chosen
  brand's hi-wall family (or ducted family when `category = ducted`). Pick the
  smallest model whose T3 capacity ≥ load. If none meets, show the largest with a
  "⚠️ undersized" note.
- **Package — SKM / APMR**: pick the smallest APMR model with `t3_kw ≥ loadKw`. If
  the load exceeds the largest APMR, **auto-fall back to APMR-A** for that row and
  tag it `↪ APMR-A (APMR range exceeded)`.
- **Package — SKM / APMR-A**: match against APMR-A directly.
- **Package — Trane**: hand to the MTZ engine at rated/standard conditions
  (schedules rarely give DB/WB/ambient); tag the row "rated conditions assumed."

## Output format

Per-row summary via the existing `sendLongText` chunker. Example:

```
📋 Schedule Selection — 7 rows

🏢 PACKAGE (SKM APMR)
• Main Praying Hall — req 4.0 TR (14.1 kW) ×8
   → APMR 51060 · 15.4 kW T3 · +9% ✅

❄️ HI-WALL SPLIT (Toshiba)
• Ladies Hall — req 3.0 TR (10.5 kW) ×2
   → RAS-... · ✅
• Guard Room — req 1.5 TR (5.3 kW) ×1
   → RAS-... · ✅

⚠️ Verify: 1 row couldn't be read
```

Selection is per-unit; `qty` is shown but does not change which model is picked.

## Error handling

- Media download failure → "I couldn't download that file. Try again, or type the
  rows manually." (mirrors VRF.)
- Vision returns no rows → tell the user no schedule rows were detected and to
  resend a clearer image.
- Module/selection exception is caught at the session handler; user gets a friendly
  failure and the session is preserved so they can resend.

## Testing

- Unit-normalization: BTU/hr, kW, TR, MBH inputs → expected kW (table-driven).
- Matching: a load just under / just over a model boundary picks the right model;
  APMR→APMR-A fallback fires when the load exceeds the APMR range.
- Classification: TYPE/heading variants → correct category.
- Extraction is validated against the sample Midea schedule (manual/fixture).
