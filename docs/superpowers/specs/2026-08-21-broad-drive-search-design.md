# Broad Drive search: stop the series detector swallowing real queries

**Date:** 2026-08-21
**Status:** Implemented

## Problem

`"fcu coil connection sheet"` returned the Catalogue/IOM button menu instead of the
FCU coil connection sheet, which lives under `Submittal Files`.

The cause is dispatch order, not a missing capability. `parseSeriesRequest` detects
the series token `fcu`, **discards `coil connection sheet`**, and — since no doc type
was named — returns `mode: "menu"`. The free filename search that would have found
the file sits later in the chain and never runs.

Confirmed by replaying the router: `findFilesByName("fcu coil connection sheet", …)`
returns the correct file for every phrasing tried. The search already worked; it was
unreachable.

## Goal

- A query carrying real words beyond the series name searches the whole index.
- Vague queries still land on the right file, without an API call.
- When a suggestion is wrong, the user can ask for a ranked scan of every file.

## Non-goals

- Indexing more of Drive. `lib/drive-index.js` already walks every subfolder
  recursively; nothing was missing.
- Using AI for this. Every part is deterministic, which is what makes it cheaper
  *and* usable on the free plan.

## Design

### New module: `lib/broad-search.js`

| Export | Behavior |
| --- | --- |
| `meaningfulTokens(text)` | Query words minus filler and doc-type words. `"sheet"`, `"coil"` survive; `"catalogue"`, `"pdf"`, `"please"` do not. |
| `hasSearchableExtras(text, series)` | Does the query say more than the series name? Decides menu vs search. |
| `rankFiles(text, files, limit)` | Scores the whole index and returns the best `limit` files. |
| `isSearchAllTrigger(text)` | `search all` / `search all files` / `search everything` / `search drive`. |
| `SEARCH_ALL_HINT` | The one-line prompt appended wherever the bot is guessing. |

**Scoring** matches the **folder path as well as the filename** — a filename hit
scores 3, a folder hit 1, and the whole query appearing intact in the filename adds 5.
That is what lets `"coil connection"` find a file inside a `07 - Coil Connection`
folder. With three or more query words, at least half must match, so a long query
doesn't return every file sharing one common word.

### Touch points in `server.js`

1. **Series-menu guard.** Inside the `mode === "menu"` branch: if the query has extra
   words, try `findFilesByName` across the full index, then `rankFiles`. Fall through
   to the menu if both come back empty — so this can only add a result, never remove
   one.
2. **`search all` interceptor**, placed after the welcome-menu block so nothing
   hijacks it. Re-runs the remembered query as a ranked full-index scan.
3. **`lastquery` context**, set once centrally rather than per lookup path, so every
   route that can produce a wrong guess gets the escape hatch for free.
4. **`sendFileOptions`** appends `SEARCH_ALL_HINT` whenever `autoSendSingle` is
   `false` — the flag that already means "these are guesses".
5. The series menu carries the same hint.

`intents.js` gains a matching `search-all` entry, keeping true its claim to be the one
place encoding router dispatch order.

## Cost

Negative. All deterministic, and queries that previously fell through to `aiMatchFile`
now resolve for free. Free-plan accounts gain real search, since none of this passes
through the `aiAllowed()` gate.

## Testing

`tests/broad-search.test.js` (10 tests): noise filtering; menu-vs-search decision
including the multi-token series case (`APMR-A`); the reported query ranking the coil
sheet first; folder-path matching; weak one-word overlap filtered out of long queries;
result cap and ordering; all-noise queries returning nothing; trigger phrasings.

`tests/intents.test.js` updated for the new dispatch entry.

## Verification

Replaying the real router branch:

| Query | Before | After |
| --- | --- | --- |
| `fcu coil connection sheet` | Catalogue/IOM menu | sends the coil connection sheet |
| `fcu coil` | Catalogue/IOM menu | sends the coil connection sheet |
| `fcu` | Catalogue/IOM menu | unchanged |
| `fcu pdf` | Catalogue/IOM menu | unchanged |
| `search all` | fell through | ranked scan of the whole index |

## Root cause #2: the file was never indexed

The coil connection sheet is an **Excel file**, and `lib/drive-index.js` only ever
collected PDFs and images:

```js
} else if (f.mimeType === "application/pdf" || /\.(pdf|png|jpe?g)$/i.test(f.name)) {
```

So no search path — free or AI — could have found it. `EXT_MIME` in `lib/wa.js`
already carried `xls`, `xlsx`, `doc`, `docx`, and `validatePdfBuffer` already skipped
non-PDFs, so the send path needed no change at all; only the index filter did.

`isIndexableFile()` now accepts `pdf, xlsx, xls, docx, doc, pptx, ppt, csv, png,
jpg, jpeg`. Native Google Docs/Sheets are deliberately excluded — they carry a
`google-apps` mimeType, have no extension, and need an export rather than a download,
so indexing them would offer files the bot then fails to send. `displayName()` strips
any indexed extension, not just `.pdf`.

## Escalation ladder

Three tiers, cheapest first, each only reached when the one before it fails:

1. **Filename match** — exact / substring / all-tokens. Free, auto-sends a single
   confident hit.
2. **`search all`** — ranked scan of the whole index including folder paths. Free,
   offered wherever the bot is guessing.
3. **`ai search`** — Claude reads the entire file list. Costs a call, so it is only
   *offered* once the free scan has returned nothing, and is gated by `aiAllowed()`
   so a free account gets the upgrade message instead.

The ladder is what makes this cheaper overall: tiers 1 and 2 resolve most queries that
previously fell through to `aiMatchFile`.
