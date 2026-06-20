# Product Document Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three unreachable Drive catalogue PDFs and two silently-broken `brand-docs.js` lookups, add the missing Toshiba VRF SMMSe catalogue entry, and add a pre-resolved Drive-ID cache for `catalogue-map.js`'s 33 series so catalogue/IOM requests skip the live Drive scan on a cache hit.

**Architecture:** Two existing deterministic lookup tables (`catalogue-map.js`, `brand-docs.js`) get corrected/extended entries — no new lookup system. A new `lib/drive-scan.js` module (extracted from `build-chiller-ids.js`) is shared by a new `build-product-ids.js` script, which writes `product-drive-ids.json`. `server.js` loads that JSON at startup and checks it before calling the live `listFolderFiles()` scan, falling back to today's exact behavior on any cache miss.

**Tech Stack:** Node.js, `googleapis` (Drive API v3), plain `node:assert` test scripts (project has no test framework — this matches the existing `test-schedule-select.js` convention).

## Global Constraints

- Filenames in `catalogue-map.js` and `brand-docs.js` must match Drive **exactly** (spaces, dashes, casing, extension) — copy them verbatim from the scan output below, do not retype.
- `productDriveIds` cache misses must fall through to the exact pre-existing live-scan logic — no new failure mode, no behavior regression on miss.
- No deploy-time build hook is added; `product-drive-ids.json` is generated locally and committed, same as `chiller-drive-ids.json`.
- Do not touch `vrf/` files — confirmed out of scope (the VRF Selection BOQ flow only triggers on the exact phrase "VRF Selection").

---

## File Structure

- **Create** `lib/drive-scan.js` — shared Drive credential loader + recursive file lister, extracted from `build-chiller-ids.js`.
- **Modify** `build-chiller-ids.js` — use `lib/drive-scan.js` instead of its inline copy. No behavior change.
- **Modify** `catalogue-map.js` — add 2 `CATALOGUE_MAP` entries.
- **Create** `test-catalogue-map.js` — assert-based regression test for `catalogue-map.js`.
- **Modify** `brand-docs.js` — fix 2 entries, add 1.
- **Create** `test-brand-docs.js` — assert-based regression test for `brand-docs.js`.
- **Create** `build-product-ids.js` — builds `product-drive-ids.json` from `CATALOGUE_MAP` + Drive.
- **Create** `product-drive-ids.json` — generated output, committed.
- **Modify** `server.js` — load the cache, change `resolveSeriesFile`'s signature, update its 3 call sites.

---

### Task 1: Extract shared Drive-scan helper

**Files:**
- Create: `lib/drive-scan.js`
- Modify: `build-chiller-ids.js:10-76`

**Interfaces:**
- Produces: `listAllFiles(): Promise<Array<{id: string, name: string, folder: string}>>` — recursively lists every PDF under `process.env.DRIVE_FOLDER_ID`, `folder` is the full path (e.g. `"Catalogues/Toshiba Catalogues"`). Reads credentials from `whatsapp-bot-498411-c3f0589ba5aa.json` in the project root if present, else `process.env.GOOGLE_SERVICE_ACCOUNT_JSON`.
- Consumes (by `build-chiller-ids.js` and the new `build-product-ids.js` in Task 4): `require('./lib/drive-scan.js').listAllFiles`.

- [ ] **Step 1: Record current output for a before/after diff**

```bash
sha256sum chiller-drive-ids.json
```
Expected: `c8876d83ab9faef673b8a7dd69e558aa43b1a96e2d18d42984f85bbb8ac9562c  chiller-drive-ids.json`
(If Drive has changed since this plan was written, the hash will differ — that's fine, just note the value so Step 5 can compare against it instead of this fixed string.)

- [ ] **Step 2: Create `lib/drive-scan.js`**

```js
// lib/drive-scan.js
// Shared Drive access: credential loading + recursive PDF listing.
// Used by build-chiller-ids.js and build-product-ids.js.
'use strict';
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

function parseServiceAccount() {
  // Try the JSON file in the project root first (works locally without .env issues)
  const jsonFile = path.join(__dirname, '..', 'whatsapp-bot-498411-c3f0589ba5aa.json');
  if (fs.existsSync(jsonFile)) return JSON.parse(fs.readFileSync(jsonFile, 'utf8'));

  // Fallback: env var (deployed / Render)
  const raw = (GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) throw new Error('No service account credentials found');
  const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const creds = JSON.parse(text.replace(/\\"/g, '"'));
  if (creds.private_key && creds.private_key.includes('\\n')) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }
  return creds;
}

async function listAllFiles() {
  if (!DRIVE_FOLDER_ID) throw new Error('DRIVE_FOLDER_ID not set');
  const credentials = parseServiceAccount();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const drive = google.drive({ version: 'v3', auth: await auth.getClient() });

  const folderPaths = { [DRIVE_FOLDER_ID]: '(root)' };
  const toVisit = [DRIVE_FOLDER_ID];
  const collected = [];

  while (toVisit.length) {
    const folderId = toVisit.shift();
    let pageToken;
    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: 100,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of res.data.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          const parentPath = folderPaths[folderId] || '(root)';
          folderPaths[f.id] = parentPath === '(root)' ? f.name : `${parentPath}/${f.name}`;
          toVisit.push(f.id);
        } else if (f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.name)) {
          collected.push({ id: f.id, name: f.name, folder: folderPaths[folderId] || '(root)' });
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }
  return collected;
}

module.exports = { listAllFiles, parseServiceAccount };
```

- [ ] **Step 3: Update `build-chiller-ids.js` to use the shared helper**

Replace lines 10-76 (the `require`s through the end of `listAllFiles`) with:

```js
'use strict';
require('dotenv').config();
const fs          = require('fs');
const path        = require('path');
const { MODELS, SERIES } = require('./chillers.js');
const { DATASHEET_FOLDERS } = require('./catalogue-map.js');
const { listAllFiles } = require('./lib/drive-scan.js');

const OUT = path.join(__dirname, 'chiller-drive-ids.json');

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
```

(This removes the local `parseServiceAccount` and `listAllFiles` definitions entirely — they now come from `lib/drive-scan.js`. The rest of the file — `findChillerFiles` and `main()` — is unchanged.)

- [ ] **Step 4: Run the script**

```bash
node build-chiller-ids.js
```
Expected: console output ending with `✅ Wrote .../chiller-drive-ids.json  (N matched, M missing)` — same N/M as before the refactor.

- [ ] **Step 5: Verify identical output**

```bash
sha256sum chiller-drive-ids.json
```
Expected: same hash as Step 1 (proves the refactor didn't change behavior — Drive contents are unchanged between the two runs).

- [ ] **Step 6: Commit**

```bash
git add lib/drive-scan.js build-chiller-ids.js
git commit -m "refactor: extract shared Drive-scan helper into lib/drive-scan.js"
```

---

### Task 2: Add the 2 missing `catalogue-map.js` series

**Files:**
- Modify: `catalogue-map.js:354-360` (end of `CATALOGUE_MAP`, before the closing `];`)
- Test: `test-catalogue-map.js`

**Interfaces:**
- Consumes: `detectSeriesEntry(text): entry|null`, `filenameFor(entry, docType): string|null` — both already exported by `catalogue-map.js`, unchanged signatures.

- [ ] **Step 1: Write the failing test**

Create `test-catalogue-map.js`:

```js
const assert = require("node:assert");
const { detectSeriesEntry, filenameFor } = require("./catalogue-map.js");

// New: Hi-Wall Non-Inverter
const hiWall = detectSeriesEntry("hi wall non inverter split catalogue");
assert.ok(hiWall, "Hi-Wall Non-Inverter should be detected");
assert.strictEqual(hiWall.name, "Hi-Wall Non-Inverter");
assert.strictEqual(
  filenameFor(hiWall, "Catalogue"),
  "SKM Wall Mounted Hi Wall Split - Non Inverter (Qatar).pdf"
);
assert.strictEqual(filenameFor(hiWall, "IOM"), null);

// New: Sierra Ducted Split
const sierra = detectSeriesEntry("sierra series catalogue");
assert.ok(sierra, "Sierra Ducted Split should be detected");
assert.strictEqual(sierra.name, "Sierra Ducted Split");
assert.strictEqual(
  filenameFor(sierra, "Catalogue"),
  "SKM Ducted Split_Catalogue - Sierra Series - R0 CBU_RX+DDP 052c 50Hz (1).pdf"
);

// Regression: existing series still resolve correctly (no alias collision)
assert.strictEqual(detectSeriesEntry("apmr catalogue").name, "APMR");
assert.strictEqual(detectSeriesEntry("apmr-a catalogue").name, "APMR-A");

console.log("All catalogue-map.js tests passed.");
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
node test-catalogue-map.js
```
Expected: `AssertionError` on the `assert.ok(hiWall, ...)` line (entry doesn't exist yet).

- [ ] **Step 3: Add the 2 entries to `catalogue-map.js`**

Find the end of the `CATALOGUE_MAP` array (currently ends at line 359 with the `Ecology Unit` entry, then `];` on line 360). Insert before the closing `];`:

```js

  // ---- Splits (in-house SKM) ----
  {
    name: "Hi-Wall Non-Inverter",
    aliases: [
      "hi wall non inverter", "wall mounted non inverter",
      "non inverter split", "skm hi wall",
    ],
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

- [ ] **Step 4: Run the test and confirm it passes**

```bash
node test-catalogue-map.js
```
Expected: `All catalogue-map.js tests passed.`

- [ ] **Step 5: Commit**

```bash
git add catalogue-map.js test-catalogue-map.js
git commit -m "feat(catalogue-map): add Hi-Wall Non-Inverter and Sierra Ducted Split series"
```

---

### Task 3: Fix Toshiba/TCL `brand-docs.js` entries + add Toshiba VRF SMMSe

**Files:**
- Modify: `brand-docs.js:143-162` (the `Toshiba Split` and `TCL Split` entries)
- Test: `test-brand-docs.js`

**Interfaces:**
- Consumes: `findBrandDocs(text, docType?): Array<{entry, file: {type, filename}}>` — already exported, unchanged signature.

- [ ] **Step 1: Write the failing test**

Create `test-brand-docs.js`:

```js
const assert = require("node:assert");
const { findBrandDocs } = require("./brand-docs.js");

// Toshiba Split: was files: [], now resolves to the real catalogue
const toshibaSplit = findBrandDocs("toshiba catalogue");
assert.ok(toshibaSplit.length >= 1, "toshiba catalogue should match something");
assert.ok(
  toshibaSplit.some((m) => m.file.filename === "Toshiba Hi Wall Split PKCV and Ducted Split BSP - Catalogue.pdf"),
  "should resolve to the real Toshiba split catalogue"
);

// TCL Split: catalogue intent
const tclCat = findBrandDocs("tcl catalogue");
assert.ok(
  tclCat.some((m) => m.file.filename === "TCL - Hi Wall Split Units Catalogue - ZGI.pdf"),
  "should resolve to the real TCL catalogue"
);

// TCL Split: IOM intent (new keyword)
const tclIom = findBrandDocs("tcl iom");
assert.ok(
  tclIom.some((m) => m.file.filename === "TCL Hi Wall Splits IOM.pdf"),
  "tcl iom should resolve to the TCL IOM"
);

// New: Toshiba VRF SMMSe
const smmse = findBrandDocs("toshiba vrf catalogue");
assert.ok(
  smmse.some((m) => m.file.filename === "Toshiba VRF SMMSe Catalogue.pdf"),
  "toshiba vrf catalogue should resolve to the SMMSe catalogue"
);

// No collision: a VRF-specific ask should not also pull in the split catalogue
assert.ok(
  !smmse.some((m) => m.file.filename === "Toshiba Hi Wall Split PKCV and Ducted Split BSP - Catalogue.pdf"),
  "toshiba vrf catalogue should not match the Toshiba Split entry"
);

// No collision: a bare split ask should not pull in the VRF catalogue
const generic = findBrandDocs("toshiba catalogue");
assert.ok(
  !generic.some((m) => m.file.filename === "Toshiba VRF SMMSe Catalogue.pdf"),
  "toshiba catalogue (no vrf) should not match the SMMSe entry"
);

console.log("All brand-docs.js tests passed.");
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
node test-brand-docs.js
```
Expected: `AssertionError` on the first `assert.ok(toshibaSplit.length >= 1, ...)` (currently `files: []` so `findBrandDocs` returns no matches for that entry).

- [ ] **Step 3: Fix and add the entries in `brand-docs.js`**

Replace the `Toshiba Split` and `TCL Split` entries (currently lines 143-162) with:

```js
  // ── TOSHIBA SPLIT ─────────────────────────────────────────────────────────
  {
    name: "Toshiba Split",
    keywords: [
      "toshiba split catalogue", "toshiba catalogue", "toshiba pkv", "toshiba ras",
      "toshiba rav", "toshiba bsp", "toshiba ducted", "toshiba hi-wall",
      "toshiba catalog", "toshiba brochure",
    ],
    files: [
      { type: "Catalogue", filename: "Toshiba Hi Wall Split PKCV and Ducted Split BSP - Catalogue.pdf" },
    ],
  },

  // ── TOSHIBA VRF SMMSe ─────────────────────────────────────────────────────
  {
    name: "Toshiba VRF SMMSe",
    keywords: [
      "toshiba vrf", "toshiba smmse", "smmse", "toshiba vrf catalogue",
      "toshiba vrf catalog", "smmse catalogue",
    ],
    files: [
      { type: "Catalogue", filename: "Toshiba VRF SMMSe Catalogue.pdf" },
    ],
  },

  // ── TCL SPLIT / CATALOGUE ─────────────────────────────────────────────────
  {
    name: "TCL Split",
    keywords: [
      "tcl catalogue", "tcl catalog", "tcl split", "tcl savein",
      "tcl hi-wall", "tcl brochure", "tcl iom", "tcl manual",
      "tcl installation manual", "tcl installation",
    ],
    files: [
      { type: "Catalogue", filename: "TCL - Hi Wall Split Units Catalogue - ZGI.pdf" },
      { type: "IOM", filename: "TCL Hi Wall Splits IOM.pdf" },
    ],
  },
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
node test-brand-docs.js
```
Expected: `All brand-docs.js tests passed.`

- [ ] **Step 5: Commit**

```bash
git add brand-docs.js test-brand-docs.js
git commit -m "fix(brand-docs): wire up Toshiba/TCL split files, add Toshiba VRF SMMSe"
```

---

### Task 4: Build the product Drive-ID cache

**Files:**
- Create: `build-product-ids.js`
- Create: `product-drive-ids.json` (generated, not hand-written)

**Interfaces:**
- Consumes: `listAllFiles` from `lib/drive-scan.js` (Task 1); `CATALOGUE_MAP`, `folderToDocType` from `catalogue-map.js`.
- Produces: `product-drive-ids.json` shaped `{ "<series name>|Catalogue": {id, name}, "<series name>|IOM": {id, name} }` — consumed by `server.js` in Task 5 as `productDriveIds[\`${entry.name}|${docType}\`]`.

- [ ] **Step 1: Create `build-product-ids.js`**

```js
// build-product-ids.js
// Run once (or after adding new catalogue/IOM PDFs to Drive, or new entries
// to catalogue-map.js):
//   node build-product-ids.js
//
// Resolves every CATALOGUE_MAP series' exact catalogue/IOM filename to its
// Drive file ID and writes product-drive-ids.json. server.js loads that file
// at startup so catalogue/IOM requests skip listFolderFiles() on a cache hit.
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { listAllFiles } = require('./lib/drive-scan.js');
const { CATALOGUE_MAP, folderToDocType } = require('./catalogue-map.js');

const OUT = path.join(__dirname, 'product-drive-ids.json');

function leafFolder(p) {
  const segs = (p || '').split('/');
  return segs[segs.length - 1] || '';
}

async function main() {
  console.log('Listing Drive files...');
  const files = await listAllFiles();
  console.log(`Found ${files.length} PDF(s)`);

  const catalogueFiles = files.filter((f) => folderToDocType(leafFolder(f.folder)) === 'Catalogue');
  const iomFiles = files.filter((f) => folderToDocType(leafFolder(f.folder)) === 'IOM');
  const byName = {
    Catalogue: new Map(catalogueFiles.map((f) => [f.name.trim().toLowerCase(), f])),
    IOM: new Map(iomFiles.map((f) => [f.name.trim().toLowerCase(), f])),
  };

  const map = {};
  let matched = 0, missing = 0, skipped = 0;

  for (const entry of CATALOGUE_MAP) {
    for (const docType of ['Catalogue', 'IOM']) {
      const exact = docType === 'Catalogue' ? entry.catalogue : entry.iom;
      if (!exact) { skipped++; continue; } // entry has no file of this type on file — not an error
      const hit = byName[docType].get(exact.trim().toLowerCase());
      const key = `${entry.name}|${docType}`;
      if (hit) {
        map[key] = { id: hit.id, name: hit.name };
        matched++;
        console.log(`  ✅ ${key} -> ${hit.name}`);
      } else {
        missing++;
        console.log(`  ⚠️  ${key} expected "${exact}" — not found in Drive`);
      }
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(map, null, 2));
  console.log(`\n✅ Wrote ${OUT}  (${matched} matched, ${missing} missing, ${skipped} skipped-no-file-on-record)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it**

```bash
node build-product-ids.js
```
Expected: console ends with `✅ Wrote .../product-drive-ids.json  (N matched, 0 missing, M skipped-no-file-on-record)`. If "missing" is not 0, stop and check whether the corresponding `catalogue-map.js` filename has a typo (compare it character-for-character against the Drive filename reported by the earlier scan) — do not commit with unexplained misses.

- [ ] **Step 3: Sanity-check the output**

```bash
node -e "const m = require('./product-drive-ids.json'); console.log(Object.keys(m).length, 'entries'); console.log(m['Hi-Wall Non-Inverter|Catalogue']); console.log(m['Sierra Ducted Split|Catalogue']);"
```
Expected: both new series print a real `{ id, name }` object (proves Task 2's entries are picked up correctly).

- [ ] **Step 4: Commit**

```bash
git add build-product-ids.js product-drive-ids.json
git commit -m "feat: add build-product-ids.js, generate product-drive-ids.json cache"
```

---

### Task 5: Wire the cache into `server.js`

**Files:**
- Modify: `server.js:191-195` (cache loading, next to `chillerDriveIds`)
- Modify: `server.js:736-764` (`resolveSeriesFile`)
- Modify: `server.js:1867-1869`, `2279-2281`, `2297-2299` (the 3 call sites)

**Interfaces:**
- Consumes: `product-drive-ids.json` (Task 4); existing `detectSeriesEntry`, `filenameFor`, `findExactFileInDoc`, `listFolderFiles` (all already defined in `server.js`/`catalogue-map.js`, unchanged).
- Produces: `resolveSeriesFile(seriesNameOrText: string, docType: string, getFiles: () => Promise<File[]>): Promise<File|null>` — **signature change**: third parameter is now a lazy zero-arg async function instead of a pre-fetched array.

- [ ] **Step 1: Load the cache at startup**

In `server.js`, right after the existing `chillerDriveIds` block (line 195), add:

```js
// Static Drive-ID map for catalogue-map.js series (built by build-product-ids.js).
// Key: "<series name>|<docType>" e.g. "APMR-A|Catalogue" -> { id, name }.
// Lets resolveSeriesFile() skip listFolderFiles() entirely on a cache hit.
let productDriveIds = {};
try { productDriveIds = require('./product-drive-ids.json'); } catch (_) {}
```

- [ ] **Step 2: Change `resolveSeriesFile` to check the cache before fetching files**

Replace the current function (lines 736-764):

```js
async function resolveSeriesFile(seriesNameOrText, docType, files) {
  // 1) Deterministic map by exact filename.
  const entry = detectSeriesEntry(seriesNameOrText);
  if (entry) {
    const exact = filenameFor(entry, docType); // exact filename or null
    if (exact) {
      const hit = findExactFileInDoc(exact, docType, files);
      if (hit) {
        console.log(`📖 Map: ${entry.name} ${docType} -> ${hit.name}`);
        return hit;
      }
      console.log(`⚠️  Map expected "${exact}" in ${docType} but it wasn't indexed (cache/rename?). Falling back.`);
    } else {
      // The map KNOWS this series has no file of this type. Be honest.
      console.log(`ℹ️  ${entry.name} has no ${docType} on file.`);
      return null;
    }
  }

  // 2) Safety net: old prefix matcher, then AI (for unmapped series).
  const hits = findFilesInFolder(seriesNameOrText, files, docType);
  if (hits.length >= 1) return hits[0];

  const folderFiles = files.filter((f) => folderMatchesDocType(f.folder, docType));
  if (!folderFiles.length) return null;
  const ai = await aiMatchSeriesFile(seriesNameOrText, docType, folderFiles);
  if (ai) console.log(`🤖 AI matched ${seriesNameOrText} ${docType} -> ${ai.name}`);
  return ai;
}
```

with:

```js
async function resolveSeriesFile(seriesNameOrText, docType, getFiles) {
  // 1) Deterministic map by exact filename.
  const entry = detectSeriesEntry(seriesNameOrText);
  if (entry) {
    const exact = filenameFor(entry, docType); // exact filename or null
    if (exact) {
      // 1a) Pre-resolved Drive-ID cache — skip the live scan entirely.
      const cached = productDriveIds[`${entry.name}|${docType}`];
      if (cached) {
        console.log(`📖 Map (direct): ${entry.name} ${docType} -> ${cached.name}`);
        return cached;
      }
      // 1b) Cache miss — fall back to the live scan + exact match.
      const files = await getFiles();
      const hit = findExactFileInDoc(exact, docType, files);
      if (hit) {
        console.log(`📖 Map: ${entry.name} ${docType} -> ${hit.name}`);
        return hit;
      }
      console.log(`⚠️  Map expected "${exact}" in ${docType} but it wasn't indexed (cache/rename?). Falling back.`);
      return await fallbackResolve(seriesNameOrText, docType, files);
    }
    // The map KNOWS this series has no file of this type. Be honest.
    console.log(`ℹ️  ${entry.name} has no ${docType} on file.`);
    return null;
  }

  // 2) No map entry at all — safety net: old prefix matcher, then AI.
  const files = await getFiles();
  return await fallbackResolve(seriesNameOrText, docType, files);
}

// Safety net for series with no map entry, or where the map's expected
// filename wasn't found live (renamed/removed in Drive since last cache build).
async function fallbackResolve(seriesNameOrText, docType, files) {
  const hits = findFilesInFolder(seriesNameOrText, files, docType);
  if (hits.length >= 1) return hits[0];

  const folderFiles = files.filter((f) => folderMatchesDocType(f.folder, docType));
  if (!folderFiles.length) return null;
  const ai = await aiMatchSeriesFile(seriesNameOrText, docType, folderFiles);
  if (ai) console.log(`🤖 AI matched ${seriesNameOrText} ${docType} -> ${ai.name}`);
  return ai;
}
```

- [ ] **Step 3: Update the 3 call sites**

Call site 1 — button tap (`folderFile` action), currently:
```js
      if (action?.type === "folderFile") {
        const files = await listFolderFiles();
        const file = await resolveSeriesFile(action.series, action.docType, files);
```
becomes:
```js
      if (action?.type === "folderFile") {
        const file = await resolveSeriesFile(action.series, action.docType, listFolderFiles);
```

Call site 2 — series-menu single-doc send, currently:
```js
          await announceSearch("🔍 Fetching that document…");
          const files = await listFolderFiles();
          const file = await resolveSeriesFile(menu.only.series, menu.only.docType, files);
```
becomes:
```js
          await announceSearch("🔍 Fetching that document…");
          const file = await resolveSeriesFile(menu.only.series, menu.only.docType, listFolderFiles);
```

Call site 3 — series-direct send, currently:
```js
      await announceSearch("🔍 Fetching that document…");
      const files = await listFolderFiles();
      const file = await resolveSeriesFile(seriesReq.series, seriesReq.docType, files);
```
becomes:
```js
      await announceSearch("🔍 Fetching that document…");
      const file = await resolveSeriesFile(seriesReq.series, seriesReq.docType, listFolderFiles);
```

- [ ] **Step 4: Syntax-check**

```bash
node -c server.js
```
Expected: no output (exit code 0 — valid syntax).

- [ ] **Step 5: Boot the server locally**

```bash
node server.js &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
```
Expected: `200` (the `/` health check route), and no stack trace in the server's stdout (confirms `require('./product-drive-ids.json')` and the `resolveSeriesFile` change didn't break startup). Leave the server running for Step 6.

- [ ] **Step 6: Smoke-test the cache-hit and fallback paths over the real webhook**

This sends real WhatsApp replies to the same test number used earlier in this session (97466279059), exactly like the existing chiller cache was verified. Run each of these and watch the server's console output:

```bash
curl -s -X POST http://localhost:3000/webhook -H "Content-Type: application/json" -d '{"entry":[{"changes":[{"value":{"messages":[{"id":"test-1","from":"97466279059","type":"text","text":{"body":"sierra series catalogue"}}]}}]}]}'
```
Expected console line: `📖 Map (direct): Sierra Ducted Split Catalogue -> SKM Ducted Split_Catalogue - Sierra Series - R0 CBU_RX+DDP 052c 50Hz (1).pdf` (cache hit — Task 2 + Task 4's new entry resolves with no live scan).

```bash
curl -s -X POST http://localhost:3000/webhook -H "Content-Type: application/json" -d '{"entry":[{"changes":[{"value":{"messages":[{"id":"test-2","from":"97466279059","type":"text","text":{"body":"apmr catalogue"}}]}}]}]}'
```
Expected console line: `📖 Map (direct): APMR Catalogue -> APMR_catalogue.pdf` (confirms an existing, previously-live-scanned series now also hits the cache with no regression).

```bash
curl -s -X POST http://localhost:3000/webhook -H "Content-Type: application/json" -d '{"entry":[{"changes":[{"value":{"messages":[{"id":"test-3","from":"97466279059","type":"text","text":{"body":"toshiba vrf catalogue"}}]}}]}]}'
```
Expected: the WhatsApp number receives the Toshiba VRF SMMSe catalogue PDF (this path goes through `brand-docs.js`, not the new cache — confirms Task 3's fix works end-to-end through the real message handler).

- [ ] **Step 7: Stop the local server**

```bash
kill %1
```

- [ ] **Step 8: Commit**

```bash
git add server.js
git commit -m "feat(server): cache-first Drive-ID lookup for catalogue-map.js series"
```

---

## Self-Review Notes

- **Spec coverage:** all 4 spec sections (catalogue-map.js entries, brand-docs.js fixes, shared scan helper, server.js cache integration) map to Tasks 1-5 above; the spec's Testing section (build script counts, smoke test of one fixed orphan / one brand-docs fix / one untouched series) is covered by Task 4 Step 2 and Task 5 Step 6.
- **Type/signature consistency:** `resolveSeriesFile`'s third parameter is renamed `files` → `getFiles` consistently across the function body (Task 5 Step 2) and all 3 call sites (Task 5 Step 3); `fallbackResolve(seriesNameOrText, docType, files)` takes an already-resolved array (not a thunk), matching how it's called in both branches of `resolveSeriesFile`.
- **No placeholders:** every step has literal code or an exact command + expected output.
