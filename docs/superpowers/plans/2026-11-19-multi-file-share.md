# Multi-file Share Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tick file cards in the `/app` chat and share them to WhatsApp in one share sheet.

**Architecture:** Browser-only. Pure helpers in `web/public/render.js` (tested in Node); page wiring in `web/public/app.js` reuses the existing file cache (`fetchEntry`, `dropEntry`, `pinned`) and `/app/api/share-link`.

**Tech Stack:** Vanilla JS, Web Share API (`navigator.share({ files })`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-19-multi-file-share-design.md`

## Global Constraints
- At most 10 ticked files (`SELECT_MAX = 10`).
- File vs link decided by the existing `shareMode(size, canShareFiles)` (25 MB cap, unknown size = link).
- No server changes; single-card Share button unchanged.

## Review Focus
- Ticked file's download fails → toast, card unticked, bar count updates.
- Share sheet closed (AbortError) → ticks stay.
- Phone no longer counts the tap after waiting (NotAllowedError) → "Tap again to share", second tap shares instantly.
- Mixed selection → files shared first, then "Send N links" offered.
- Unticking during download → download aborted, memory freed.

---

### Task 1: Selection helpers

**Files:** Modify `web/public/render.js`; Test `tests/web-render.test.js`

**Interfaces — Produces:**
- `SELECT_MAX` = 10
- `splitSelection(cards, canShareFiles) -> { files: card[], links: card[] }` (order kept; uses `shareMode`)
- `selectionSummary(cards) -> string` — `"1 selected"`, `"3 selected · 4.2 MB"` (sum of known sizes via `formatSize`; omit size if none known)
- `linksMessage(items: {name, url}[]) -> string` — `name\nurl` per item, joined by `"\n\n"`

- [ ] Tests: split by size/canShare; summary with/without sizes; links message format.
- [ ] Run `node --test tests/web-render.test.js` → FAIL, implement, → PASS.

### Task 2: Tick boxes, bar, multi-share

**Files:** Modify `web/public/app.js`, `web/public/index.html`, `web/public/styles.css`

- [ ] Checkbox in each Drive card head (`fc.check`); `selected` array of fc; on tick: limit check, pin/fetch if file mode; on untick: unpin (dropEntry if not prefetched).
- [ ] Bar `#selbar` above composer: summary, Clear, primary "Share N files" / "Send N links".
- [ ] Share tap: if all file entries ready → `navigator.share({ files })` inside the tap; else wait ("Getting files… x/N") then try (NotAllowedError → "Tap again to share"). Success → if links remain, button becomes "Send N links"; else clear. AbortError → keep.
- [ ] Links: fetch each share link, then `location.href = wa.me/?text=linksMessage(...)`, then clear.
- [ ] Verify in browser preview (mocked share), run full `npm test`, commit.
