# Schedule Image Selection — Offline Verification Results

**Date:** 2026-06-17
**Branch:** `feature/schedule-image-selection`
**Tester:** Automated (Task 8 subagent)

---

## Step 1 — Static checks

### `node test-schedule-select.js`

```
Task 6 OK
```

Exit: 0 — all assertions passed.

### `node --check server.js`

```
(no output)
```

Exit: 0 — syntax clean.

### `node --check schedule-select.js`

```
(no output)
```

Exit: 0 — syntax clean.

---

## Step 2 — Realistic end-to-end dry-run

Input: Midea mosque schedule (7 raw rows, 6 readable, 1 skipped — "Store" has no capacity).
Capacities at T3 (46°C outdoor).

### Scenario A — T3 · Toshiba splits · SKM APMR package

```
summarize: {"count":6,"hasSplit":true,"hasPackage":true}
--- T3, Toshiba splits, SKM APMR package ---
📋 *Schedule Selection* — 6 rows · rated at T3

🏢 *PACKAGE (SKM APMR)*
• Main Praying Hall — req 4.0 TR (14.1 kW) ×8
   → APMR 51060 · 15.4 kW T3 · ✅

❄️ *SPLIT (Toshiba)*
• Main Praying Hall (hi-wall) — req 3.0 TR (10.6 kW) ×2
   → RAS-30PKV / RAS-30PAV · 6.4 kW T3 · ⚠️ undersized
• Main Praying Hall (hi-wall) — req 1.5 TR (5.3 kW) ×1
   → RAS-24PKV / RAS-24PAV · 5.7 kW T3 · ✅
• Ladies Praying Hall (hi-wall) — req 3.0 TR (10.6 kW) ×2
   → RAS-30PKV / RAS-30PAV · 6.4 kW T3 · ⚠️ undersized
• Guard Room (hi-wall) — req 1.5 TR (5.3 kW) ×1
   → RAS-24PKV / RAS-24PAV · 5.7 kW T3 · ✅
• Imam House Kitchen (hi-wall) — req 1.5 TR (5.3 kW) ×1
   → RAS-24PKV / RAS-24PAV · 5.7 kW T3 · ✅

⚠️ *Verify: 1 row(s) couldn't be read*
• Store
```

### Scenario B — T3 · SKM splits · Trane MTZ package

```
--- T3, SKM splits, Trane package ---
📋 *Schedule Selection* — 6 rows · rated at T3

🏢 *PACKAGE (Trane MTZ)*
• Main Praying Hall — req 4.0 TR (14.1 kW) ×8
   → MTZ MTZH075 · 6.2 TR · ✅ _(rated indoor 80/67°F)_

❄️ *SPLIT (SKM)*
• Main Praying Hall (hi-wall) — req 3.0 TR (10.6 kW) ×2
   → MSKMP-36CVK1C60 · 8.1 kW T3 · ⚠️ undersized
• Main Praying Hall (hi-wall) — req 1.5 TR (5.3 kW) ×1
   → MSKMP-24CVK1C60 · 5.9 kW T3 · ✅
• Ladies Praying Hall (hi-wall) — req 3.0 TR (10.6 kW) ×2
   → MSKMP-36CVK1C60 · 8.1 kW T3 · ⚠️ undersized
• Guard Room (hi-wall) — req 1.5 TR (5.3 kW) ×1
   → MSKMP-24CVK1C60 · 5.9 kW T3 · ✅
• Imam House Kitchen (hi-wall) — req 1.5 TR (5.3 kW) ×1
   → MSKMP-24CVK1C60 · 5.9 kW T3 · ✅

⚠️ *Verify: 1 row(s) couldn't be read*
• Store
```

---

## Step 3 — Regression reference table

| Input capacity (T3) | Selected model (Scenario A) | Adequate? | Notes |
|---|---|---|---|
| 48,000 BTU/HR (14.1 kW) package | APMR 51060 · 15.4 kW | ✅ | Smallest APMR >= load |
| 36,000 BTU/HR (10.6 kW) Toshiba hi-wall | RAS-30PKV · 6.4 kW | ⚠️ undersized | Correct — hi-wall tops out ~6.4 kW T3; spec calls for ducted or packaged instead |
| 18,000 BTU/HR (5.3 kW) Toshiba hi-wall | RAS-24PKV · 5.7 kW | ✅ | 0.4 kW margin |

The ⚠️ undersized result for 36,000 BTU hi-wall splits is **intentional and correct behaviour**: Toshiba PKV hi-walls peak at ~6.4 kW T3, well below the 10.6 kW requirement. The bot correctly surfaces this so the engineer can switch to a ducted or package solution. Any future regression that silently passes a 36,000 BTU hi-wall as adequate should be treated as a bug.

---

## Step 4 — Live smoke test (manual, pending)

Requires: deployed bot on Render + a WhatsApp number that has messaged the bot within 24 h.

Steps (from implementation plan Task 8 Step 2):

- [ ] 1. Send `Schedule Selection` to the bot number. Expect the reply: _"Send the equipment schedule as an image or PDF."_
- [ ] 2. Send the sample Midea mosque schedule image (or any real project BOQ photo/PDF).
- [ ] 3. Expect _"I read N rows"_ followed by _"Rate at T1/T3?"_. Reply `2` (T3 = 46°C).
- [ ] 4. Expect _"Which split brand?"_. Reply `1` (Toshiba).
- [ ] 5. Expect _"Package line?"_. Reply `1` (SKM), then `1` (APMR).
- [ ] 6. Verify the final reply:
  - Package rows appear under "PACKAGE (SKM APMR)" with APMR model codes and kW T3.
  - Split rows appear under "SPLIT (Toshiba)" with RAS-xxPKV labels and kW T3.
  - Each row shows capacity as `x.x TR (xx.x kW)`.
  - Any row with unreadable capacity appears in the "⚠️ Verify" section.
  - The Store row (no capacity) is in the verify list, not selected.

Record which APMR code and which RAS-xx model appear for the 48,000 BTU package row and the 18,000 BTU split rows — these match the regression table above and confirm the live extraction matches the offline dry-run.
