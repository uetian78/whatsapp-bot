# AI Related-Document Fallback on "Not Found" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the WhatsApp bot can't find a requested document, ask AI for genuinely-relevant alternatives from the Drive index and let the user pick one, instead of just saying "not found."

**Architecture:** A new pure-logic module (`lib/related-files.js`) parses an AI response into file objects (testable without network calls). A new `aiRelatedFiles()` function in `server.js` calls Haiku with a strict relevance bar and delegates parsing to that module. A new `sendNotFoundWithSuggestions()` wrapper calls `aiRelatedFiles()` and either presents a caveated choice (via a small `sendFileOptions` extension) or falls back to the existing plain not-found message. Ten existing not-found call sites are rewired to use the wrapper.

**Tech Stack:** Node.js (CommonJS), `@anthropic-ai/sdk` (Claude Haiku), `node:assert` for tests (no test framework — matches existing `test-*.js` convention).

**Spec:** [docs/superpowers/specs/2026-06-24-ai-related-document-fallback-design.md](../specs/2026-06-24-ai-related-document-fallback-design.md)

## Global Constraints

- Model for all AI matching in this feature: `claude-haiku-4-5-20251001` (text-only — matches existing `aiMatchFile`/`askClaude` usage).
- Hard cap: at most 5 related-document suggestions per fallback.
- Relevance bar: the AI must reply `"0"` when nothing is genuinely relevant — never force a suggestion.
- A single related match must NOT auto-send; it must be presented as a caveated choice (`sendFileOptions(..., false)`).
- Caveat message text (exact): `` `I couldn't find an exact match for "${text}". We might not have that exact document, but here are the closest ones I have — pick one below. If none fit, email hassan.saleem@mannai.com.qa.` ``
- Out of scope, must NOT change: `sendDriveFile` upload-failure fallback (`server.js:961`), `sendRule` upload-failure fallback (`server.js:1001`), `datasheetFile` button tap (`server.js:1882`), `fileid|` button tap (`server.js:1939`), and all structured-selection-flow errors (split unit, schedule, VRF intake).
- `aiRelatedFiles` always returns an array (`[]` on no match/no key/error) — never `null` — so callers can do `if (hits.length)` directly.

---

## Task 1: `lib/related-files.js` — parse an AI response into file objects

**Files:**
- Create: `lib/related-files.js`
- Test: `test-related-files.js`

**Interfaces:**
- Produces: `parseRelatedFilesResponse(rawText, files, maxResults = 5)` — pure function. `rawText` is the raw text Haiku replied with (e.g. `"3"`, `"0"`, `"1, 4, 7"`, or free text containing digits). `files` is the array of `{ id, name, ... }` Drive file objects being numbered 1-based. Returns an array of file objects (subset of `files`, in the order their numbers appeared, deduped, capped at `maxResults`), or `[]` if nothing valid is found.

- [ ] **Step 1: Write the failing test**

Create `test-related-files.js`:

```js
const assert = require("node:assert");
const { parseRelatedFilesResponse } = require("./lib/related-files.js");

const files = [
  { name: "AHU MAH Catalogue.pdf" },        // 1
  { name: "AHU CAH Catalogue.pdf" },        // 2
  { name: "FCU Catalogue.pdf" },            // 3
  { name: "APMR-A Catalogue.pdf" },         // 4
  { name: "Chiller APCY-H Catalogue.pdf" }, // 5
  { name: "Chiller APCY-E Catalogue.pdf" }, // 6
  { name: "VRF Catalogue.pdf" },            // 7
];

// "0" means nothing relevant -> empty array
assert.deepStrictEqual(parseRelatedFilesResponse("0", files), []);

// Single number -> single file
assert.deepStrictEqual(
  parseRelatedFilesResponse("3", files).map((f) => f.name),
  ["FCU Catalogue.pdf"]
);

// Multiple numbers, comma separated, order preserved (best-first)
assert.deepStrictEqual(
  parseRelatedFilesResponse("5, 6", files).map((f) => f.name),
  ["Chiller APCY-H Catalogue.pdf", "Chiller APCY-E Catalogue.pdf"]
);

// Numbers embedded in extra text are still extracted
assert.deepStrictEqual(
  parseRelatedFilesResponse("I think 1 and 4 are close", files).map((f) => f.name),
  ["AHU MAH Catalogue.pdf", "APMR-A Catalogue.pdf"]
);

// Duplicates are deduped, first-occurrence order kept
assert.deepStrictEqual(
  parseRelatedFilesResponse("2, 2, 7", files).map((f) => f.name),
  ["AHU CAH Catalogue.pdf", "VRF Catalogue.pdf"]
);

// Out-of-range numbers are dropped silently
assert.deepStrictEqual(
  parseRelatedFilesResponse("2, 99, 7", files).map((f) => f.name),
  ["AHU CAH Catalogue.pdf", "VRF Catalogue.pdf"]
);

// No digits at all -> empty array
assert.deepStrictEqual(parseRelatedFilesResponse("no match", files), []);

// Empty/undefined input -> empty array
assert.deepStrictEqual(parseRelatedFilesResponse("", files), []);
assert.deepStrictEqual(parseRelatedFilesResponse(undefined, files), []);

// Capped at maxResults (default 5) even if more numbers are given
assert.deepStrictEqual(
  parseRelatedFilesResponse("1,2,3,4,5,6,7", files).map((f) => f.name),
  [
    "AHU MAH Catalogue.pdf",
    "AHU CAH Catalogue.pdf",
    "FCU Catalogue.pdf",
    "APMR-A Catalogue.pdf",
    "Chiller APCY-H Catalogue.pdf",
  ]
);

// Custom maxResults param respected
assert.deepStrictEqual(
  parseRelatedFilesResponse("1,2,3,4,5", files, 2).map((f) => f.name),
  ["AHU MAH Catalogue.pdf", "AHU CAH Catalogue.pdf"]
);

console.log("All related-files tests passed.");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-related-files.js`
Expected: `Error: Cannot find module './lib/related-files.js'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/related-files.js`:

```js
// lib/related-files.js
// Parses an AI "related documents" reply (e.g. "0", "3", "1, 4, 7") into
// actual file objects: extracts every number, drops out-of-range/duplicate
// numbers, keeps best-first order, caps at maxResults. A bare "0" (the
// model's "nothing relevant" signal) naturally yields [] since 0 fails the
// `n >= 1` range check below — no special-casing needed.
'use strict';

function parseRelatedFilesResponse(rawText, files, maxResults = 5) {
  const nums = (rawText || "").match(/\d+/g);
  if (!nums) return [];

  const seen = new Set();
  const picked = [];
  for (const numStr of nums) {
    const n = parseInt(numStr, 10);
    if (n < 1 || n > files.length) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    picked.push(files[n - 1]);
    if (picked.length >= maxResults) break;
  }
  return picked;
}

module.exports = { parseRelatedFilesResponse };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-related-files.js`
Expected: `All related-files tests passed.`

- [ ] **Step 5: Commit**

```bash
git add lib/related-files.js test-related-files.js
git commit -m "feat(not-found): add parseRelatedFilesResponse for AI suggestion parsing"
```

---

## Task 2: `aiRelatedFiles()` — Haiku call with a strict relevance bar

**Files:**
- Modify: `server.js:27` (add require)
- Modify: `server.js:597` (insert new function after `aiMatchFile`)

**Interfaces:**
- Consumes: `parseRelatedFilesResponse(rawText, files, maxResults)` from Task 1.
- Produces: `async function aiRelatedFiles(text, files)` → `Promise<Array<file>>` (always an array, never `null`). Used by Task 3's `sendNotFoundWithSuggestions`.

- [ ] **Step 1: Add the require**

In `server.js`, find:

```js
const { findFilesByName } = require("./lib/find-files-by-name.js");
```

Add immediately after it:

```js
const { findFilesByName } = require("./lib/find-files-by-name.js");
const { parseRelatedFilesResponse } = require("./lib/related-files.js");
```

- [ ] **Step 2: Add `aiRelatedFiles()` after `aiMatchFile()`**

In `server.js`, find (the end of `aiMatchFile` and the start of the next function's comment):

```js
    return picked.length ? picked : null; // array of matches
  } catch (err) {
    console.error("AI match error:", err.message);
    return null;
  }
}

// AI-pick the single file in a folder that matches a requested SERIES.
```

Replace with:

```js
    return picked.length ? picked : null; // array of matches
  } catch (err) {
    console.error("AI match error:", err.message);
    return null;
  }
}

// AI fallback for a lookup miss: finds documents that are genuinely relevant
// to the request (not just loosely related) so a not-found reply can offer
// alternatives instead of a dead end. Returns [] (never null) when nothing
// clears the relevance bar, so callers can do `if (hits.length)` directly.
async function aiRelatedFiles(text, files) {
  if (!ANTHROPIC_API_KEY || !files.length) return [];

  const list = files.map((f, i) => `${i + 1}. ${f.name.replace(/\.[^.]+$/, "")}`).join("\n");

  const system = `A customer's request did not match any file exactly. Find documents from the list below that are GENUINELY RELEVANT to what they asked for — close enough that a human would reasonably offer them as alternatives.
The list may include SKM brand files as well as third-party brand catalogues (Hisense, Daikin, Mitsubishi, Trane, Carrier, etc.).
Use your knowledge of HVAC abbreviations and brand names:
- MAH = Modular Air Handling Unit (AHU)
- CAH = Comfort Air Handling Unit (AHU)
- FCU = Fan Coil Unit
- APMR-A = Packaged Air Conditioner
- AUMR-A = Air-Cooled Condensing Unit
- APCY-P / APCY-H / APCY-E = Air-Cooled Screw Chillers
- ACMR = Air-Cooled Scroll Chiller
- PAC4A = 100% Fresh Air Packaged Unit (DOAS)
- PAC4A 5xxxx = a specific PAC4A unit selection sheet
- VRF / VRV = Variable Refrigerant Flow/Volume multi-split system
- Also match third-party brand names directly (e.g. "Hisense VRF" matches any file with "Hisense" and "VRF" in the name)

Apply a STRICT relevance bar — do NOT suggest a file just because it shares a generic word (e.g. "unit", "catalogue") or a loosely related category. Only suggest files for the SAME product type/series/brand the customer asked about.

Reply with up to 5 numbers, best match first, separated by commas.
If NOTHING is genuinely relevant, reply with "0".
No other text.

FILES:
${list}`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 40,
      system,
      messages: [{ role: "user", content: text }],
    });
    const out = (msg.content?.[0]?.text || "").trim();
    return parseRelatedFilesResponse(out, files);
  } catch (err) {
    console.error("AI related-files error:", err.message);
    return [];
  }
}

// AI-pick the single file in a folder that matches a requested SERIES.
```

- [ ] **Step 3: Verify syntax**

Run: `node -c server.js`
Expected: no output (exit code 0 — means the file parses as valid JS).

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(not-found): add aiRelatedFiles AI matcher with strict relevance bar"
```

---

## Task 3: `sendNotFoundWithSuggestions()` wrapper + `sendFileOptions` extension

**Files:**
- Modify: `server.js:1058-1074` (extend `sendFileOptions`, add new wrapper after it)

**Interfaces:**
- Consumes: `aiRelatedFiles(text, files)` from Task 2; `listFolderFiles()`, `sendText()`, `sendButtons()`, `NOT_FOUND_MSG` (all pre-existing in `server.js`).
- Produces: `sendFileOptions(to, matchedFiles, prompt, autoSendSingle = true)` (extended signature, backward compatible) and `async function sendNotFoundWithSuggestions(to, text, files)` (the `files` param is optional). Used by Task 4 and Task 5's call-site rewires.

- [ ] **Step 1: Extend `sendFileOptions` and add the wrapper**

In `server.js`, find:

```js
async function sendFileOptions(to, matchedFiles, prompt) {
  if (matchedFiles.length === 1) return sendDriveFile(to, matchedFiles[0]);

  if (matchedFiles.length <= 3) {
    const buttons = matchedFiles.map((f) => ({
      id: `fileid|${f.id}`,
      title: displayName(f).slice(0, 20),
    }));
    return sendButtons(to, prompt || "Which one would you like?", buttons);
  }

  // 4+ options: numbered list stored for next reply (supersedes any open menu)
  delete pendingMenu[to];
  pendingLists[to] = matchedFiles;
  const list = matchedFiles.map((f, i) => `${i + 1}. ${displayName(f)}`).join("\n");
  return sendText(to, `${prompt || "I found several matches:"}\n\n${list}\n\nReply with a number to get the file.`);
}
```

Replace with:

```js
async function sendFileOptions(to, matchedFiles, prompt, autoSendSingle = true) {
  if (autoSendSingle && matchedFiles.length === 1) return sendDriveFile(to, matchedFiles[0]);

  if (matchedFiles.length <= 3) {
    const buttons = matchedFiles.map((f) => ({
      id: `fileid|${f.id}`,
      title: displayName(f).slice(0, 20),
    }));
    return sendButtons(to, prompt || "Which one would you like?", buttons);
  }

  // 4+ options: numbered list stored for next reply (supersedes any open menu)
  delete pendingMenu[to];
  pendingLists[to] = matchedFiles;
  const list = matchedFiles.map((f, i) => `${i + 1}. ${displayName(f)}`).join("\n");
  return sendText(to, `${prompt || "I found several matches:"}\n\n${list}\n\nReply with a number to get the file.`);
}

// Last-resort reply for a lookup miss: ask AI for documents that are
// genuinely relevant to the request and offer them as a caveated choice
// (never auto-sent — a related match is a guess, not a confirmed answer).
// Falls back to the plain NOT_FOUND_MSG when nothing clears the relevance
// bar. `files` is optional — pass the already-fetched Drive index when the
// caller has one in scope; otherwise it's fetched here (cheap:
// listFolderFiles() caches for FILE_CACHE_MS).
async function sendNotFoundWithSuggestions(to, text, files) {
  const fileList = files || (await listFolderFiles());
  const hits = await aiRelatedFiles(text, fileList);
  console.log(`🔎 Related-files fallback for "${text}": ${hits.length} suggestion(s)`);
  if (hits.length) {
    const caveat = `I couldn't find an exact match for "${text}". We might not have that exact document, but here are the closest ones I have — pick one below. If none fit, email hassan.saleem@mannai.com.qa.`;
    return sendFileOptions(to, hits, caveat, false);
  }
  return sendText(to, NOT_FOUND_MSG);
}
```

- [ ] **Step 2: Verify syntax**

Run: `node -c server.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(not-found): add sendNotFoundWithSuggestions wrapper"
```

---

## Task 4: Rewire the 6 free-text lookup-miss call sites

**Files:**
- Modify: `server.js` (six call sites + delete `suggestionMessage`)

**Interfaces:**
- Consumes: `sendNotFoundWithSuggestions(to, text, files)` from Task 3.

- [ ] **Step 1: Remove `suggestionMessage` (keep `NOT_FOUND_MSG`)**

Find:

```js
const NOT_FOUND_MSG = "Cannot find requested file — Email hassan.saleem@mannai.com.qa to get the required file.\n\n" + MENU_HINT;

// Not-found reply. (Previously this guessed "closest documents" via fuzzy
// keyword matching, but that surfaced irrelevant suggestions — e.g. a VRF query
// matched "PAC4A SELECTIONS" — so we now just send the clean not-found message,
// which already points to email and the menu.)
function suggestionMessage(text, rules) {
  return NOT_FOUND_MSG;
}
```

Replace with:

```js
const NOT_FOUND_MSG = "Cannot find requested file — Email hassan.saleem@mannai.com.qa to get the required file.\n\n" + MENU_HINT;
```

- [ ] **Step 2: Datasheet explicit (around line 2275)**

Find:

```js
      // No datasheet on file for this code. If the user explicitly asked for a
      // datasheet (word "datasheet"/spec or a T1/T3), say so. If it was just
      // "<series> <code>", fall through so the rest of the pipeline can try.
      if (dsReq.explicit) {
        return await sendText(from, NOT_FOUND_MSG);
      }
    }
```

Replace with:

```js
      // No datasheet on file for this code. If the user explicitly asked for a
      // datasheet (word "datasheet"/spec or a T1/T3), say so. If it was just
      // "<series> <code>", fall through so the rest of the pipeline can try.
      if (dsReq.explicit) {
        return await sendNotFoundWithSuggestions(from, text, files);
      }
    }
```

(`files` is already declared earlier in this same block via `const files = await listFolderFiles();`.)

- [ ] **Step 3: Series single-doc (around line 2298)**

Find:

```js
          const file = await resolveSeriesFile(menu.only.series, menu.only.docType, listFolderFiles);
          if (file) return await sendDriveFile(from, file);
          return await sendText(
            from,
            NOT_FOUND_MSG
          );
        }
```

Replace with:

```js
          const file = await resolveSeriesFile(menu.only.series, menu.only.docType, listFolderFiles);
          if (file) return await sendDriveFile(from, file);
          return await sendNotFoundWithSuggestions(from, text);
        }
```

- [ ] **Step 4: Series direct (around line 2313)**

Find:

```js
      console.log(`📚 Series direct: ${seriesReq.series} ${seriesReq.docType}`);
      await announceSearch("🔍 Fetching that document…");
      const file = await resolveSeriesFile(seriesReq.series, seriesReq.docType, listFolderFiles);
      if (file) return await sendDriveFile(from, file);
      return await sendText(
        from,
        NOT_FOUND_MSG
      );
    }
```

Replace with:

```js
      console.log(`📚 Series direct: ${seriesReq.series} ${seriesReq.docType}`);
      await announceSearch("🔍 Fetching that document…");
      const file = await resolveSeriesFile(seriesReq.series, seriesReq.docType, listFolderFiles);
      if (file) return await sendDriveFile(from, file);
      return await sendNotFoundWithSuggestions(from, text);
    }
```

- [ ] **Step 5: Brand-doc not on Drive (around line 2412)**

Find:

```js
        if (resolved.length === 1) return await sendDriveFile(from, resolved[0]);
        if (resolved.length > 1) return await sendFileOptions(from, resolved, "Here are the matching documents:");
        // filename listed in brand-docs.js but not yet on Drive
        return await sendText(from, NOT_FOUND_MSG);
      }
    }
```

Replace with:

```js
        if (resolved.length === 1) return await sendDriveFile(from, resolved[0]);
        if (resolved.length > 1) return await sendFileOptions(from, resolved, "Here are the matching documents:");
        // filename listed in brand-docs.js but not yet on Drive
        return await sendNotFoundWithSuggestions(from, text, files);
      }
    }
```

- [ ] **Step 6: Bare model code without "detail" (around line 2424)**

Find:

```js
    const wantsDetail = /\bdetails?\b/i.test(text);
    const hasModelCode = /\d{5}/.test(text);
    if (hasModelCode && !wantsDetail && !isKnowledgeQuestion) {
      console.log(`🚫 model code without "detail" -> not-found (no AI details): "${text}"`);
      return await sendText(from, NOT_FOUND_MSG);
    }
```

Replace with:

```js
    const wantsDetail = /\bdetails?\b/i.test(text);
    const hasModelCode = /\d{5}/.test(text);
    if (hasModelCode && !wantsDetail && !isKnowledgeQuestion) {
      console.log(`🚫 model code without "detail" -> not-found (no AI details): "${text}"`);
      return await sendNotFoundWithSuggestions(from, text, files);
    }
```

- [ ] **Step 7: Final generic fallback (around line 2464)**

Find:

```js
    // 4) General question -> answer from the Knowledge tab via Claude Haiku
    const aiReply = await askClaude(text, knowledge);
    if (aiReply && !/connect you with a team member/i.test(aiReply)) {
      return await sendText(from, aiReply);
    }

    // 5) Nothing matched -> show closest documents if any, otherwise standard apology
    await sendText(from, suggestionMessage(text, rules));
  } catch (err) {
```

Replace with:

```js
    // 4) General question -> answer from the Knowledge tab via Claude Haiku
    const aiReply = await askClaude(text, knowledge);
    if (aiReply && !/connect you with a team member/i.test(aiReply)) {
      return await sendText(from, aiReply);
    }

    // 5) Nothing matched -> AI suggests related documents, or the standard apology
    await sendNotFoundWithSuggestions(from, text, files);
  } catch (err) {
```

- [ ] **Step 8: Verify syntax**

Run: `node -c server.js`
Expected: no output.

- [ ] **Step 9: Run the existing regression suite**

Run: `node test-find-files-by-name.js && node test-brand-docs.js && node test-catalogue-map.js && node test-schedule-select.js && node test-related-files.js`
Expected: each prints its own "All ... tests passed." line, no errors.

- [ ] **Step 10: Commit**

```bash
git add server.js
git commit -m "feat(not-found): rewire free-text lookup misses to suggest related documents"
```

---

## Task 5: Rewire the 4 button-tap lookup-miss call sites

**Files:**
- Modify: `server.js` (four call sites inside the `message.type === "interactive"` button-tap handler)

**Interfaces:**
- Consumes: `sendNotFoundWithSuggestions(to, text, files)` from Task 3.

- [ ] **Step 1: `folderFile` action — catalogue/IOM choice (around line 1867)**

Find:

```js
      // Catalogue / IOM choice -> fetch from that folder ONLY
      if (action?.type === "folderFile") {
        const file = await resolveSeriesFile(action.series, action.docType, listFolderFiles);
        if (file) return await sendDriveFile(from, file);
        return await sendText(
          from,
          NOT_FOUND_MSG
        );
      }
```

Replace with:

```js
      // Catalogue / IOM choice -> fetch from that folder ONLY
      if (action?.type === "folderFile") {
        const file = await resolveSeriesFile(action.series, action.docType, listFolderFiles);
        if (file) return await sendDriveFile(from, file);
        return await sendNotFoundWithSuggestions(from, `${action.series} ${action.docType}`);
      }
```

(No `files` variable is in scope in this block, so the call omits it — `sendNotFoundWithSuggestions` fetches via the cached `listFolderFiles()` internally.)

Leave the next block (`datasheetFile` action, ends with `NOT_FOUND_MSG` around line 1882) **unchanged** — it's explicitly out of scope (Global Constraints).

- [ ] **Step 2: `sheet` action — model data sheet (around line 1885)**

Find:

```js
      if (action?.type === "sheet") {
        // fetch the model data sheet PDF from the Drive folder by name
        const files = await listFolderFiles();
        let hits = findFilesByName(action.fileName, files);
        // If condition (t1/t3) is known, filter to the matching file
        if (action.condition && hits.length > 1) {
          const condUpper = action.condition.toUpperCase(); // "T1" or "T3"
          const condFiltered = hits.filter((f) => {
            const n = f.name.toUpperCase();
            return n.includes(`-${condUpper}`) || n.includes(`_${condUpper}`) || n.includes(` ${condUpper}`);
          });
          if (condFiltered.length >= 1) hits = condFiltered;
        }
        if (hits.length >= 1) return await sendDriveFile(from, hits[0]);
        return await sendText(
          from,
          NOT_FOUND_MSG
        );
      }
```

Replace with:

```js
      if (action?.type === "sheet") {
        // fetch the model data sheet PDF from the Drive folder by name
        const files = await listFolderFiles();
        let hits = findFilesByName(action.fileName, files);
        // If condition (t1/t3) is known, filter to the matching file
        if (action.condition && hits.length > 1) {
          const condUpper = action.condition.toUpperCase(); // "T1" or "T3"
          const condFiltered = hits.filter((f) => {
            const n = f.name.toUpperCase();
            return n.includes(`-${condUpper}`) || n.includes(`_${condUpper}`) || n.includes(` ${condUpper}`);
          });
          if (condFiltered.length >= 1) hits = condFiltered;
        }
        if (hits.length >= 1) return await sendDriveFile(from, hits[0]);
        return await sendNotFoundWithSuggestions(from, action.fileName, files);
      }
```

- [ ] **Step 3: `doctype|` button — doc-type-filtered AI match empty (around line 1905)**

Find:

```js
      if (btnId.startsWith("doctype|")) {
        const [, docType, ...queryParts] = btnId.split("|");
        const query = queryParts.join("|");
        const files = await listFolderFiles();
        const filtered = files.filter((f) => fileMatchesDocType(f, docType));
        const aiHits = await aiMatchFile(query, filtered);
        if (aiHits && aiHits.length >= 1) return await sendFileOptions(from, aiHits, `${docType} — which product?`);
        return await sendText(from, NOT_FOUND_MSG);
      }
```

Replace with:

```js
      if (btnId.startsWith("doctype|")) {
        const [, docType, ...queryParts] = btnId.split("|");
        const query = queryParts.join("|");
        const files = await listFolderFiles();
        const filtered = files.filter((f) => fileMatchesDocType(f, docType));
        const aiHits = await aiMatchFile(query, filtered);
        if (aiHits && aiHits.length >= 1) return await sendFileOptions(from, aiHits, `${docType} — which product?`);
        return await sendNotFoundWithSuggestions(from, query, files);
      }
```

(Pass the full `files` index, not the doc-type-filtered `filtered`, so the relevance search isn't artificially narrowed — matching the design spec's "search the full index" rule.)

- [ ] **Step 4: `fcu-sheet|` button — FCU model sheet (around line 1915)**

Find:

```js
        if (hits.length >= 1) return await sendFileOptions(from, hits, `${model} datasheets (choose coil rows):`);
        // Fallback: search by name anywhere in Drive if folder filter missed
        const fallback = files.filter((f) => norm(f.name.replace(/\.[^.]+$/, "")).startsWith(q) && f.name.toLowerCase().endsWith(".pdf"));
        if (fallback.length >= 1) return await sendFileOptions(from, fallback, `${model} datasheets:`);
        return await sendText(from, NOT_FOUND_MSG);
      }
```

Replace with:

```js
        if (hits.length >= 1) return await sendFileOptions(from, hits, `${model} datasheets (choose coil rows):`);
        // Fallback: search by name anywhere in Drive if folder filter missed
        const fallback = files.filter((f) => norm(f.name.replace(/\.[^.]+$/, "")).startsWith(q) && f.name.toLowerCase().endsWith(".pdf"));
        if (fallback.length >= 1) return await sendFileOptions(from, fallback, `${model} datasheets:`);
        return await sendNotFoundWithSuggestions(from, model, files);
      }
```

Leave the `fileid|` block (ends with `NOT_FOUND_MSG` around line 1939) **unchanged** — explicitly out of scope.

- [ ] **Step 5: Verify syntax**

Run: `node -c server.js`
Expected: no output.

- [ ] **Step 6: Run the existing regression suite**

Run: `node test-find-files-by-name.js && node test-brand-docs.js && node test-catalogue-map.js && node test-schedule-select.js && node test-related-files.js`
Expected: each prints its own "All ... tests passed." line, no errors.

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat(not-found): rewire button-tap lookup misses to suggest related documents"
```

---

## Task 6: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Confirm `NOT_FOUND_MSG` is still referenced and `suggestionMessage` is gone**

Run: `grep -n "suggestionMessage\|NOT_FOUND_MSG" server.js`
Expected: `suggestionMessage` produces no matches; `NOT_FOUND_MSG` still appears at its definition plus the 2 explicitly-out-of-scope sites (`sendDriveFile`/`sendRule` upload failures) and the 2 explicitly-out-of-scope button taps (`datasheetFile`, `fileid|`) and inside `sendNotFoundWithSuggestions` itself — i.e. fewer occurrences than before, not zero.

- [ ] **Step 2: Start the bot locally**

Run (in the project root, with the existing `.env` populated): `node server.js`
Expected: console prints `🚀 Listening on 3000` (or the configured `PORT`) with no startup errors.

- [ ] **Step 3: Simulate a not-found free-text request**

In a second terminal, send a WhatsApp-shaped webhook payload for a request you know has no exact file (e.g. a series/code that doesn't exist in your Drive index — check `/drive-index` first to confirm):

```bash
curl -s -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{
      "changes": [{
        "value": {
          "contacts": [{ "profile": { "name": "Test User" } }],
          "messages": [{
            "id": "test-msg-1",
            "from": "10000000000",
            "type": "text",
            "text": { "body": "VRF system catalogue zzz999" }
          }]
        }
      }]
    }]
  }'
```

Expected: HTTP response is immediate `200` (the handler ACKs before processing). In the server console, look for the line `🔎 Related-files fallback for "VRF system catalogue zzz999": N suggestion(s)`. If `N > 0`, the bot attempted to send a caveated suggestion list to WhatsApp (this will fail without a real `WHATSAPP_TOKEN`/test number — that's expected locally; the goal here is confirming the AI fallback path fired, not a full WhatsApp round-trip). If `N === 0`, confirm the plain `NOT_FOUND_MSG` path was used instead.

- [ ] **Step 4: Confirm no junk suggestions for a clearly unrelated request**

Repeat Step 3 with a request that should NOT find anything close, e.g. `"completely unrelated nonsense xyz"`. Expected: `0 suggestion(s)` in the log — confirming the relevance bar is holding (this is the exact failure mode that got the old "closest documents" feature removed).

- [ ] **Step 5: Stop the server**

Stop the `node server.js` process (Ctrl+C in its terminal).

No commit for this task (verification only, no file changes).

---

## Self-Review Notes

- **Spec coverage:** All 10 call sites from the (now-updated) design spec are covered across Tasks 4 and 5. The 4 explicitly-out-of-scope sites (`sendDriveFile`, `sendRule`, `datasheetFile`, `fileid|`) are called out and left untouched in both tasks' steps.
- **Type consistency:** `aiRelatedFiles` (Task 2) and `sendNotFoundWithSuggestions` (Task 3) both consistently treat "no relevant files" as `[]`, never `null` — verified against every call site added in Tasks 4–5, none of which check for `null`.
- **No placeholders:** every step shows the literal code to find and the literal code to replace it with; no "similar to Task N" shortcuts.
