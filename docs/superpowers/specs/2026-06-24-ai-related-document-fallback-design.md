# AI Related-Document Fallback on "Not Found"

**Date:** 2026-06-24
**Status:** Approved (design)
**Component:** `server.js` (WhatsApp bot document lookup)

## Problem

When the bot cannot resolve a requested file, it sends a plain
`NOT_FOUND_MSG` ("Cannot find requested file — Email
hassan.saleem@mannai.com.qa ...") and stops. Users get no help discovering
documents the bot actually has.

A previous "closest documents" feature existed but was **deliberately
removed** (see comment at `server.js:496`) because it used fuzzy keyword
distance and surfaced irrelevant suggestions (a VRF query matched
"PAC4A SELECTIONS"). Any replacement must not reintroduce that problem.

## Goal

On a not-found, ask AI to find genuinely-relevant documents from the Drive
index and present them as a selectable list, prefixed with an honest caveat
that the exact requested document may not be on file. When AI finds nothing
truly relevant, fall back to the existing plain message — never show wrong
guesses.

## Decisions (from brainstorming)

- **Trigger scope:** all not-found *lookup* exits route through the new
  search (datasheet, series, bare model code, brand-docs, generic fallback).
- **Relevance guard:** show only confident/genuinely-relevant matches; if
  none, send the plain not-found message. Always include a caveat noting the
  exact document may not exist.
- **Presentation:** reuse `sendFileOptions` (buttons for ≤3, numbered list
  for 4–5), capped at 5. Selection is already wired.

## Architecture

### 1. `aiRelatedFiles(text, files)` — new function

Sibling to the existing `aiMatchFile` (`server.js:549`); kept separate so the
precise primary matcher is untouched.

- Haiku call (`claude-haiku-4-5-20251001`), same pattern as `aiMatchFile`.
- Given the full Drive file list (numbered, extension stripped).
- System prompt instructs: return **up to 5** file numbers that are
  *genuinely relevant* to the request, ordered best-first, applying a
  relevance bar; reply `0` if nothing is truly related. Reuse the HVAC
  abbreviation/brand guidance block from `aiMatchFile` so domain terms are
  understood.
- Parses numbers, maps to file objects, dedupes, caps at 5.
- Returns an array of ≤5 file objects, or `[]`.
- On missing `ANTHROPIC_API_KEY`, empty file list, or error → `[]`.

Searches the **full** index (not the doc-type-filtered subset), since this is
a last resort and the original request may have been misread.

### 2. `sendNotFoundWithSuggestions(from, text)` — new wrapper

Replaces the direct `sendText(from, NOT_FOUND_MSG)` calls at the lookup-miss
sites.

- Fetches the file index via `listFolderFiles()` (cached — `server.js:258` —
  so cheap; reuse the in-scope `files` where already available to avoid even
  the cache lookup).
- Calls `aiRelatedFiles(text, files)`.
  - **Hits found** → present via `sendFileOptions(from, hits, caveat, false)`
    with caveat text along the lines of:
    > "I couldn't find an exact match for "{request}". We might not have that
    > exact document, but here are the closest ones I have — pick one below.
    > If none fit, email hassan.saleem@mannai.com.qa."
  - **No hits** → `sendText(from, NOT_FOUND_MSG)` (unchanged).

### 3. `sendFileOptions` — small additive change

Add an optional `autoSendSingle = true` parameter (`server.js:1058`). Current
behavior auto-sends when exactly one file matches. Because related matches are
fuzzy (not a confirmed answer), the new path passes `false` so a lone result
is still presented as a choice with the caveat rather than sent as if it were
the answer. All existing callers omit the param → behavior unchanged.

## Selection / presentation

No new selection handling needed. `sendFileOptions` already:
- uses `fileid|<id>` buttons for ≤3 results, and
- stores `pendingLists[to]` + a numbered text list for 4–5,

both already resolved by the existing reply handler.

## Call sites that change (all → `sendNotFoundWithSuggestions(from, text)`)

Free-text lookup pipeline:

| Location | Context |
|---|---|
| `server.js:2275` | Explicit datasheet not on file |
| `server.js:2302` | Series single-doc unresolved |
| `server.js:2319` | Series direct unresolved |
| `server.js:2415` | Brand-doc listed but not on Drive |
| `server.js:2428` | Bare model code without "detail" |
| `server.js:2465` | Final generic fallback (via `suggestionMessage`) |

Button-tap handler (same category — a fresh lookup miss, just triggered by a
button instead of free text; the text proxy passed to `aiRelatedFiles` is
noted per row):

| Location | Context | Text proxy passed |
|---|---|---|
| `server.js:1872` | `folderFile` action — catalogue/IOM choice unresolved | `` `${action.series} ${action.docType}` `` |
| `server.js:1901` | `sheet` action — model data sheet unresolved | `action.fileName` |
| `server.js:1912` | `doctype\|` button — AI match empty after doc-type filter | `query` (already extracted from the button id) |
| `server.js:1930` | `fcu-sheet\|` button — FCU model sheet unresolved | `model` (already extracted from the button id) |

`suggestionMessage()` (`server.js:500`) is removed; its sole call site
(`server.js:2465`) calls `sendNotFoundWithSuggestions` directly.

## Explicitly out of scope (stay as plain `NOT_FOUND_MSG`)

- `sendDriveFile` upload-failure fallback (`server.js:961`)
- `sendRule` document upload-failure fallback (`server.js:1001`)

These are **send/upload errors**, not lookup misses — the requested file was
found, so AI suggestions would be misleading.

- `datasheetFile` action — T1/T3 condition tap (`server.js:1882`)
- `fileid|` button — direct file-by-id tap (`server.js:1939`)

These two button taps re-fetch a file that was already identified earlier in
the conversation (by Drive ID); a miss here means the file vanished from
Drive between being offered and being tapped, not that the original request
was unmatched. There is no human-readable request text available at this
point to feed the AI matcher, so these stay as plain `NOT_FOUND_MSG`.

Structured selection flows that emit their own specific errors (split unit,
schedule, VRF intake — e.g. `server.js:1280`, `1490`, `1518`, `1797`) are
unchanged; they are not file-lookup misses.

## Cost / performance

- One extra Haiku call only on a not-found (cheap, short max_tokens).
- `listFolderFiles()` is cached, so early-exit paths incur at most a cache
  lookup, not a Drive round-trip.

## Risk mitigation

The old version surfaced junk via fuzzy keyword distance. This version
delegates relevance to AI with an explicit bar, shows nothing (plain message)
when AI returns `0`, and frames any results with an honest "we might not have
your exact document" caveat.

## Testing

- Unit/behavioral: `aiRelatedFiles` returns `[]` on no API key, on `0`
  response, and on parse failure; caps at 5; dedupes.
- Pipeline: each changed call site, when its file is absent, produces either a
  relevant suggestion list or the plain message — never irrelevant guesses.
- Regression: existing `sendFileOptions` callers still auto-send a lone match.
- Manual: a known-absent request (e.g. a VRF query when no VRF doc exists)
  does **not** surface unrelated PAC4A/other files.
