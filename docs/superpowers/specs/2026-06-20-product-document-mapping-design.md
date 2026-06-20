# Product Document Mapping — Fix Gaps + Add Drive-ID Cache

**Date:** 2026-06-20
**Status:** Approved design, pending implementation plan

## Problem

The bot resolves "send me the X catalogue/IOM" requests through two
deterministic lookup tables — `catalogue-map.js` (in-house SKM product
series) and `brand-docs.js` (third-party brands + misc documents) — both of
which match user text to an **exact Drive filename**, then resolve that
filename against a live, recursively-scanned Drive file index
(`listFolderFiles()` in `server.js`, cached in-memory for 2 minutes).

A live scan against the actual Drive folder turned up two problems:

1. **Three real PDFs are unreachable.** Two SKM catalogues
   (`SKM Wall Mounted Hi Wall Split - Non Inverter (Qatar).pdf`,
   `SKM Ducted Split_Catalogue - Sierra Series - R0 CBU_RX+DDP 052c 50Hz (1).pdf`)
   exist in Drive but have no entry in either lookup table, so no keyword
   resolves to them. A third (`APMR-V KU_catalogue.pdf`) turned out to
   already be mapped in `brand-docs.js` — not actually broken.
2. **Two `brand-docs.js` entries are silently broken.** `Toshiba Split` and
   `TCL Split` have keyword lists that match real user phrasing (e.g.
   "toshiba catalogue") but an empty `files: []` array. `findBrandDocs()`
   only pushes a result when it can iterate `entry.files`, so a keyword hit
   with no files produces **zero matches**, not a "not found" message — the
   request silently falls through to the generic AI/knowledge-base path
   instead of returning a PDF.
3. There is no real Drive file for the Toshiba VRF line — `Toshiba VRF
   SMMSe Catalogue.pdf` exists in Drive but has no `brand-docs.js` entry at
   all, so even an exact ask for "Toshiba SMMSe catalogue" never resolves.

Separately, the existing chiller flow (`chiller-drive-ids.json`, built by
`build-chiller-ids.js`) shows a faster pattern: pre-resolve Drive file IDs
once, commit the JSON, and have button taps skip `listFolderFiles()`
entirely. `catalogue-map.js`'s 33 series have no equivalent — every
catalogue/IOM request pays for a live Drive scan/match (amortized by the
2-minute cache, but still a cold path on every cache expiry).

## Goals

- Every real Drive catalogue/IOM PDF that has a sensible product identity is
  reachable by at least one keyword, through the existing two-table
  architecture (no new lookup system).
- Fix the two broken `brand-docs.js` placeholder entries and add the missing
  Toshiba VRF SMMSe entry.
- Add a pre-resolved Drive-ID cache for `catalogue-map.js`'s 33 series,
  mirroring the chiller pattern, so the live-scan path becomes a fallback
  instead of the only path.
- Zero behavior regression: any cache miss (stale ID, unmapped series) must
  fall back to exactly today's live-scan-and-match behavior.

## Non-Goals

- No new lookup table or schema — reuse `catalogue-map.js` /
  `brand-docs.js` exactly as they exist today, just with corrected/added
  entries.
- No Drive-ID cache for `brand-docs.js` lookups in this pass — those are
  lower-traffic third-party catalogues and the live-scan path is fast
  enough; can be revisited later if needed.
- No deploy-time auto-regeneration of the new cache. Like
  `chiller-drive-ids.json`, it's built locally with a manual script run and
  committed; `render.yaml` has no build-step hook for this today and this
  spec doesn't add one.
- No changes to the VRF Selection BOQ flow (`vrf/`) — confirmed
  `isVrfTrigger` only matches the exact phrase "VRF Selection", so the new
  `Toshiba VRF SMMSe` brand-docs keywords ("toshiba vrf", "smmse", etc.)
  cannot collide with it.

## Decisions (locked during brainstorming)

| Topic | Decision |
|---|---|
| Hi-Wall Non-Inverter / Sierra Ducted Split | New `catalogue-map.js` series entries (in-house SKM products, same pattern as existing entries). |
| APMR-V KU | No change — already correctly mapped in `brand-docs.js`. |
| Toshiba Split / TCL Split | Fix in place: populate `files: []` with the real catalogue (+ IOM for TCL) filenames. |
| Toshiba VRF SMMSe | New `brand-docs.js` entry, kept keyword-distinct from "Toshiba Split" (no bare "toshiba catalogue" overlap). |
| Drive-ID cache scope | `catalogue-map.js`'s 33 series only, not `brand-docs.js`. |
| Cache regeneration | Manual `node build-product-ids.js`, committed JSON — same workflow as the chiller cache. |
| Shared Drive-scan code | Extract into `lib/drive-scan.js`, used by both `build-chiller-ids.js` and the new `build-product-ids.js`, to avoid a third copy of the credential-loading + recursive-listing logic. |

## Content fixes

**`catalogue-map.js`** — add 2 entries:

```js
{
  name: "Hi-Wall Non-Inverter",
  aliases: ["hi wall non inverter", "wall mounted non inverter", "non inverter split", "skm hi wall"],
  catalogue: "SKM Wall Mounted Hi Wall Split - Non Inverter (Qatar).pdf",
  iom: null,
},
{
  name: "Sierra Ducted Split",
  aliases: ["sierra", "sierra series", "sierra ducted split", "ducted split sierra"],
  catalogue: "SKM Ducted Split_Catalogue - Sierra Series - R0 CBU_RX+DDP 052c 50Hz (1).pdf",
  iom: null,
},
```

**`brand-docs.js`** — fix 2, add 1:

```js
// fix: was files: []
{
  name: "Toshiba Split",
  keywords: [ /* unchanged */ ],
  files: [{ type: "Catalogue", filename: "Toshiba Hi Wall Split PKCV and Ducted Split BSP - Catalogue.pdf" }],
},
// fix: was files: []
{
  name: "TCL Split",
  keywords: [ /* unchanged */ ],
  files: [
    { type: "Catalogue", filename: "TCL - Hi Wall Split Units Catalogue - ZGI.pdf" },
    { type: "IOM", filename: "TCL Hi Wall Splits IOM.pdf" },
  ],
},
// new
{
  name: "Toshiba VRF SMMSe",
  keywords: ["toshiba vrf", "toshiba smmse", "smmse", "toshiba vrf catalogue", "toshiba vrf catalog", "smmse catalogue"],
  files: [{ type: "Catalogue", filename: "Toshiba VRF SMMSe Catalogue.pdf" }],
},
```

## Drive-ID cache architecture

**`lib/drive-scan.js`** (new) — exports `listAllFiles()` and the service
account credential loader, extracted verbatim from `build-chiller-ids.js`
so both build scripts share one implementation.

**`build-chiller-ids.js`** — updated to import `listAllFiles` from
`lib/drive-scan.js` instead of defining it inline. No behavior change.

**`build-product-ids.js`** (new) — for every entry in
`CATALOGUE_MAP` (from `catalogue-map.js`), find the Drive file matching its
exact `catalogue` and `iom` filename (within a folder whose name resolves
to that doc type via `folderToDocType`), and write `product-drive-ids.json`:

```json
{
  "APMR-A|Catalogue": { "id": "...", "name": "APMR-A. 2025_catalogue.pdf" },
  "APMR-A|IOM": { "id": "...", "name": "APMRA 2025 IOM_IOM.pdf" }
}
```

Key format `"<series name>|<docType>"` mirrors the chiller cache's
`"<code>|<series>"` convention. Entries are only written when a match is
found (same as the chiller script's "matched/missing" reporting).

**`server.js`** integration:

- Load the cache at startup, next to `chillerDriveIds`:
  ```js
  let productDriveIds = {};
  try { productDriveIds = require('./product-drive-ids.json'); } catch (_) {}
  ```
- Change `resolveSeriesFile(seriesNameOrText, docType, files)` to
  `resolveSeriesFile(seriesNameOrText, docType, getFiles)`, where `getFiles`
  is a zero-arg async function (the existing `listFolderFiles` reference
  can be passed directly — no wrapper needed). Inside, before calling
  `getFiles()`, check `productDriveIds[\`${entry.name}|${docType}\`]`; on a
  hit, return that `{id, name}` immediately — `getFiles()` is never called.
  On a miss (no entry for that key — the series isn't in the cache, or the
  cache hasn't been rebuilt since this entry was added), fall through to
  exactly today's logic: `await getFiles()` then `findExactFileInDoc`, then
  the AI/prefix-matcher safety net. This is a pure prepend — none of the
  existing fallback logic changes.
- Update the 3 call sites (button-tap `folderFile` action, series-menu
  single-doc send, series-direct send) to stop pre-fetching:
  `resolveSeriesFile(x, y, listFolderFiles)` instead of
  `const files = await listFolderFiles(); resolveSeriesFile(x, y, files)`.

## Error handling / staleness

If `product-drive-ids.json` is missing entirely (e.g. fresh checkout before
the build script has been run), the `require` is wrapped in `try/catch` and
`productDriveIds` stays `{}` — every lookup is a cache miss and behavior is
identical to today (live scan every time). If a cached ID points to a file
that's since been renamed or removed from Drive, `sendDriveFile` will get a
stale ID — same risk that already exists for `chillerDriveIds` today, with
no new failure mode introduced. A future improvement (not in this pass)
would be having `sendDriveFile` detect a 404 and fall back to a live
re-resolve, but that's out of scope here since the chiller path doesn't do
it either.

## Testing

- Run `build-product-ids.js` once after merging and confirm console output
  reports 33/33 (or N/33 with named exceptions) matched, no unexpected
  misses.
- Manual WhatsApp smoke test (per the `run`/`verify` skills) for: one fixed
  orphan (Sierra Ducted Split), one fixed brand-docs entry (Toshiba Split),
  the new Toshiba VRF SMMSe catalogue, and one untouched existing series
  (e.g. APMR catalogue) to confirm the cache-hit path still returns the
  correct file and the fallback path is unaffected.
- No automated test suite exists for `server.js`'s WhatsApp flows today;
  this spec doesn't add one (consistent with existing project conventions).
