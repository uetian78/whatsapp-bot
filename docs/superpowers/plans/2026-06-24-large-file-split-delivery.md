# Split Oversized PDFs for WhatsApp Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Drive file is found correctly but is too large for WhatsApp to accept as a single document upload (HTTP 413 from Meta's media API), split the PDF into page-range parts and send each as a separate "Part i of N" message instead of falling back to the misleading plain not-found message.

**Architecture:** A new `lib/pdf-split.js` exposes a pure `splitPdfIntoParts(buffer, maxPartSizeBytes)` function (built on `pdf-lib`) that divides a PDF's pages evenly across enough parts to fit a size budget. `server.js`'s two file-delivery paths — `sendDriveFile` and `sendRule`'s document branch — are changed to download the file's bytes themselves (instead of letting `uploadMedia` do it invisibly), so that on a 413 upload failure they can hand the already-downloaded buffer to a new shared `sendFileInParts` helper, which splits and sends the parts sequentially.

**Tech Stack:** Node.js, `pdf-lib` (new dependency, PDF loading/splitting), `pdfkit` (existing, used only by the test to build a fixture PDF), `node:assert` (existing test convention).

## Global Constraints

- Per-part size budget: `MAX_PART_SIZE_BYTES = 20 * 1024 * 1024` (20 MB) — a safety margin under Meta's documented 100 MB per-document cap.
- Only `.pdf` files are split. Non-PDF oversized files keep falling back to the existing plain `NOT_FOUND_MSG`.
- Images are never split — `sendDriveFile`'s image branch and `sendRule`'s image branch are untouched.
- Parts are sent sequentially (awaited one at a time, never `Promise.all`), so they arrive in order.
- Part filename format: `"<niceName> (Part <i> of <N>).pdf"`. Part caption format: `` `Here is <niceName> (Part <i> of <N>) 📄` `` — `<i>` is 1-indexed.
- If a PDF cannot be reduced under the budget by page splitting (e.g. it has only one page), fall back to `sendText(to, NOT_FOUND_MSG)` rather than attempting a send that would fail again.
- Never `git add -A` or `git add .` — this repo has untracked credential files at its root. Always `git add` specific filenames.

---

### Task 1: `lib/pdf-split.js` — PDF page-range splitter

**Files:**
- Modify: `package.json` (add `pdf-lib` dependency)
- Create: `lib/pdf-split.js`
- Create: `test-pdf-split.js`

**Interfaces:**
- Produces: `splitPdfIntoParts(buffer: Buffer, maxPartSizeBytes: number) -> Promise<Buffer[]>`. If `buffer.length <= maxPartSizeBytes`, returns `[buffer]` (the exact same reference, untouched). If the PDF has only one page and is over the budget, returns `[buffer]` (signals "cannot split further" — callers must treat a single-element return for an over-budget input as failure to split). Otherwise returns `> 1` `Buffer`s, each a standalone valid PDF (starts with `%PDF`), whose page counts sum to the original total page count.

- [ ] **Step 1: Add the `pdf-lib` dependency**

Edit `package.json` — add `"pdf-lib"` to `dependencies`, alphabetically between `"googleapis"` and `"pdfkit"`:

```json
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.1",
    "axios": "^1.7.2",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "form-data": "^4.0.5",
    "googleapis": "^144.0.0",
    "pdf-lib": "^1.17.1",
    "pdfkit": "^0.15.0",
    "xlsx": "^0.18.5"
  }
```

Run: `npm install`
Expected: `pdf-lib` added to `node_modules/` and to `package-lock.json` with no errors.

- [ ] **Step 2: Write the failing test**

Create `test-pdf-split.js`:

```js
// test-pdf-split.js
const assert = require("node:assert");
const PDFDocument = require("pdfkit");
const { PDFDocument: PdfLibDocument } = require("pdf-lib");
const { splitPdfIntoParts } = require("./lib/pdf-split.js");

// Builds a real, valid N-page PDF buffer using pdfkit (same chunks/Buffer.concat
// pattern as mtz-pdf.js), so the splitting logic runs against real PDF bytes.
function buildPdf(pageCount) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ autoFirstPage: false });
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    for (let i = 0; i < pageCount; i++) {
      doc.addPage();
      doc.text(`Page ${i + 1}`);
    }
    doc.end();
  });
}

(async () => {
  // 1) Buffer already under the threshold -> returned unchanged, same reference.
  const small = Buffer.from("not a real pdf but small");
  const resultSmall = await splitPdfIntoParts(small, 1000);
  assert.strictEqual(resultSmall.length, 1);
  assert.strictEqual(resultSmall[0], small);
  console.log("PASS: buffer under threshold returned unchanged");

  // 2) Single-page PDF over the threshold -> can't be split further, returned unchanged.
  const onePage = await buildPdf(1);
  const resultOnePage = await splitPdfIntoParts(onePage, 10);
  assert.strictEqual(resultOnePage.length, 1);
  console.log("PASS: single-page PDF over threshold cannot be split further");

  // 3) Multi-page PDF over the threshold -> splits into multiple valid PDF parts.
  const sixPages = await buildPdf(6);
  assert.ok(sixPages.length > 100, "fixture PDF should be a real, non-trivial size");
  const maxPartSizeBytes = Math.ceil(sixPages.length / 3); // force splitting into ~3 parts
  const parts = await splitPdfIntoParts(sixPages, maxPartSizeBytes);
  assert.ok(parts.length > 1, `expected multiple parts, got ${parts.length}`);

  let totalPages = 0;
  for (const part of parts) {
    assert.strictEqual(part.slice(0, 4).toString("utf8"), "%PDF", "each part must be a valid PDF");
    const doc = await PdfLibDocument.load(part);
    totalPages += doc.getPageCount();
    assert.ok(part.length <= sixPages.length, "no part should exceed the original size");
  }
  assert.strictEqual(totalPages, 6, "split parts' pages must sum to the original page count");
  console.log(`PASS: multi-page PDF split into ${parts.length} valid parts totaling ${totalPages} pages`);

  console.log("All pdf-split tests passed.");
})().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node test-pdf-split.js`
Expected: `FAIL` with a `Cannot find module './lib/pdf-split.js'` error (the module doesn't exist yet).

- [ ] **Step 4: Write the implementation**

Create `lib/pdf-split.js`:

```js
// lib/pdf-split.js
// Splits an oversized PDF buffer into smaller, standalone PDF buffers by page
// range, so each part can be uploaded to WhatsApp separately when the whole
// document exceeds the platform's per-document size limit.
'use strict';

const { PDFDocument } = require('pdf-lib');

async function splitPdfIntoParts(buffer, maxPartSizeBytes) {
  if (buffer.length <= maxPartSizeBytes) return [buffer];

  const src = await PDFDocument.load(buffer);
  const totalPages = src.getPageCount();
  if (totalPages <= 1) return [buffer]; // can't split a single page further

  const numParts = Math.ceil(buffer.length / maxPartSizeBytes);
  const pagesPerPart = Math.ceil(totalPages / numParts);

  const parts = [];
  for (let start = 0; start < totalPages; start += pagesPerPart) {
    const end = Math.min(start + pagesPerPart, totalPages);
    const indices = [];
    for (let i = start; i < end; i++) indices.push(i);

    const doc = await PDFDocument.create();
    const copiedPages = await doc.copyPages(src, indices);
    copiedPages.forEach((p) => doc.addPage(p));
    parts.push(Buffer.from(await doc.save()));
  }
  return parts;
}

module.exports = { splitPdfIntoParts };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node test-pdf-split.js`
Expected:
```
PASS: buffer under threshold returned unchanged
PASS: single-page PDF over threshold cannot be split further
PASS: multi-page PDF split into 3 valid parts totaling 6 pages
All pdf-split tests passed.
```
(The exact part count in the third line may vary slightly, but must be `> 1` and total pages must equal `6`.)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/pdf-split.js test-pdf-split.js
git commit -m "feat(pdf-split): add splitPdfIntoParts for oversized document delivery"
```

---

### Task 2: `sendDriveFile` splits on 413 instead of failing silently

**Files:**
- Modify: `server.js:25-30` (add a require for the Task 1 module)
- Modify: `server.js:883-907` (`uploadMedia` — dedupe its inline PDF check against the new shared helper)
- Modify: `server.js:941-971` (insert `validatePdfBuffer`, `MAX_PART_SIZE_BYTES`, `sendFileInParts`; rewrite `sendDriveFile`)

**Interfaces:**
- Consumes: `splitPdfIntoParts(buffer, maxPartSizeBytes) -> Promise<Buffer[]>` from Task 1 (`./lib/pdf-split.js`).
- Produces: `validatePdfBuffer(buffer: Buffer, filename: string) -> void` (throws on an invalid PDF signature, does nothing otherwise) and `sendFileInParts(to: string, buffer: Buffer, filename: string, niceName: string) -> Promise<void>` — both used by Task 3.

- [ ] **Step 1: Add the new require**

In `server.js`, find this line (around line 28):

```js
const { parseRelatedFilesResponse } = require("./lib/related-files.js");
```

Add immediately after it:

```js
const { splitPdfIntoParts } = require("./lib/pdf-split.js");
```

- [ ] **Step 2: Extract `validatePdfBuffer` and have `uploadMedia` use it**

Find this block (around line 864-907):

```js
// Download a file. Accepts either {link} or {fileId}. For Drive, downloads
// via the Drive API using the service account (reliable, no virus-scan page).
async function downloadBytes({ link, fileId }) {
  const id = fileId || (link ? driveFileId(link) : null);

  if (id) {
    const drive = await getDrive();
    const res = await drive.files.get(
      { fileId: id, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    );
    return Buffer.from(res.data);
  }

  // Non-Drive link: direct HTTP download.
  const r = await axios.get(link, { responseType: "arraybuffer", maxRedirects: 5 });
  return Buffer.from(r.data);
}

async function uploadMedia({ link, fileId, filename }) {
  const buffer = await downloadBytes({ link, fileId });
  const mime = mimeFromName(filename);

  // sanity check: a real PDF starts with "%PDF"
  if (mime === "application/pdf") {
    const sig = buffer.slice(0, 5).toString("utf8");
    if (!sig.startsWith("%PDF")) {
      throw new Error(
        `Downloaded file is not a valid PDF (got ${buffer.length} bytes starting "${sig}"). ` +
        `Check the bot's access to this file.`
      );
    }
  }

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mime });
  form.append("type", mime);

  const up = await axios.post(MEDIA_URL, form, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, ...form.getHeaders() },
  });
  return up.data.id; // media ID
}
```

Replace it with (adds `validatePdfBuffer`, has `uploadMedia` call it instead of repeating the check inline):

```js
// Download a file. Accepts either {link} or {fileId}. For Drive, downloads
// via the Drive API using the service account (reliable, no virus-scan page).
async function downloadBytes({ link, fileId }) {
  const id = fileId || (link ? driveFileId(link) : null);

  if (id) {
    const drive = await getDrive();
    const res = await drive.files.get(
      { fileId: id, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    );
    return Buffer.from(res.data);
  }

  // Non-Drive link: direct HTTP download.
  const r = await axios.get(link, { responseType: "arraybuffer", maxRedirects: 5 });
  return Buffer.from(r.data);
}

// Sanity check: a real PDF starts with "%PDF". Throws if filename says PDF
// but the downloaded bytes say otherwise (e.g. an HTML error page served
// instead of the file, due to a permissions problem).
function validatePdfBuffer(buffer, filename) {
  const mime = mimeFromName(filename);
  if (mime !== "application/pdf") return;
  const sig = buffer.slice(0, 5).toString("utf8");
  if (!sig.startsWith("%PDF")) {
    throw new Error(
      `Downloaded file is not a valid PDF (got ${buffer.length} bytes starting "${sig}"). ` +
      `Check the bot's access to this file.`
    );
  }
}

async function uploadMedia({ link, fileId, filename }) {
  const buffer = await downloadBytes({ link, fileId });
  validatePdfBuffer(buffer, filename);
  const mime = mimeFromName(filename);

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mime });
  form.append("type", mime);

  const up = await axios.post(MEDIA_URL, form, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, ...form.getHeaders() },
  });
  return up.data.id; // media ID
}
```

- [ ] **Step 3: Add `sendFileInParts` and rewrite `sendDriveFile`**

Find this block (around line 941-971):

```js
// Send a generated buffer to a user as a WhatsApp document.
async function sendDocument(to, buffer, filename, caption) {
  const mediaId = await uploadMediaBuffer(buffer, filename);
  return send(to, {
    messaging_product: "whatsapp", to, type: "document",
    document: { id: mediaId, filename, caption: caption || "" },
  });
}

// Send a file found in the Drive folder, by its Drive ID.
async function sendDriveFile(to, file) {
  const isImage = /\.(png|jpe?g)$/i.test(file.name);
  const niceName = file.name.replace(/\.[^.]+$/, "");
  const caption = `Here is ${niceName} 📄`;
  try {
    const mediaId = await uploadMedia({ fileId: file.id, filename: file.name });
    if (isImage) {
      return send(to, {
        messaging_product: "whatsapp", to, type: "image",
        image: { id: mediaId, caption },
      });
    }
    return send(to, {
      messaging_product: "whatsapp", to, type: "document",
      document: { id: mediaId, filename: file.name, caption },
    });
  } catch (err) {
    console.error("❌ Drive file send error:", err.response?.data || err.message);
    return sendText(to, NOT_FOUND_MSG);
  }
}
```

Replace it with:

```js
// Send a generated buffer to a user as a WhatsApp document.
async function sendDocument(to, buffer, filename, caption) {
  const mediaId = await uploadMediaBuffer(buffer, filename);
  return send(to, {
    messaging_product: "whatsapp", to, type: "document",
    document: { id: mediaId, filename, caption: caption || "" },
  });
}

// Safety margin under Meta's documented 100MB per-document cap — splitting
// at 20MB absorbs the slack from page-count-based (not exact-byte) splitting.
const MAX_PART_SIZE_BYTES = 20 * 1024 * 1024;

// Splits an oversized PDF buffer (already downloaded) into parts and sends
// each as a separate, numbered WhatsApp document. Falls back to the plain
// not-found-style message if the PDF can't be split further, or if any part
// fails to send.
async function sendFileInParts(to, buffer, filename, niceName) {
  try {
    const parts = await splitPdfIntoParts(buffer, MAX_PART_SIZE_BYTES);
    if (parts.length <= 1) {
      console.error(`❌ "${filename}" is too large to send and cannot be split further.`);
      return sendText(to, NOT_FOUND_MSG);
    }
    for (let i = 0; i < parts.length; i++) {
      const partFilename = `${niceName} (Part ${i + 1} of ${parts.length}).pdf`;
      const partCaption = `Here is ${niceName} (Part ${i + 1} of ${parts.length}) 📄`;
      const mediaId = await uploadMediaBuffer(parts[i], partFilename);
      await send(to, {
        messaging_product: "whatsapp", to, type: "document",
        document: { id: mediaId, filename: partFilename, caption: partCaption },
      });
    }
  } catch (err) {
    console.error(`❌ Split-and-send error for "${filename}":`, err.response?.data || err.message);
    return sendText(to, NOT_FOUND_MSG);
  }
}

// Send a file found in the Drive folder, by its Drive ID.
async function sendDriveFile(to, file) {
  const isImage = /\.(png|jpe?g)$/i.test(file.name);
  const niceName = file.name.replace(/\.[^.]+$/, "");
  const caption = `Here is ${niceName} 📄`;

  if (isImage) {
    try {
      const mediaId = await uploadMedia({ fileId: file.id, filename: file.name });
      return send(to, {
        messaging_product: "whatsapp", to, type: "image",
        image: { id: mediaId, caption },
      });
    } catch (err) {
      console.error("❌ Drive file send error:", err.response?.data || err.message);
      return sendText(to, NOT_FOUND_MSG);
    }
  }

  let buffer;
  try {
    buffer = await downloadBytes({ fileId: file.id });
    validatePdfBuffer(buffer, file.name);
  } catch (err) {
    console.error("❌ Drive file download error:", err.message);
    return sendText(to, NOT_FOUND_MSG);
  }

  try {
    const mediaId = await uploadMediaBuffer(buffer, file.name);
    return send(to, {
      messaging_product: "whatsapp", to, type: "document",
      document: { id: mediaId, filename: file.name, caption },
    });
  } catch (err) {
    if (err.response?.status === 413 && /\.pdf$/i.test(file.name)) {
      return await sendFileInParts(to, buffer, file.name, niceName);
    }
    console.error("❌ Drive file send error:", err.response?.data || err.message);
    return sendText(to, NOT_FOUND_MSG);
  }
}
```

- [ ] **Step 4: Verify syntax**

Run: `node -c server.js`
Expected: no output, exit code 0 (valid syntax).

- [ ] **Step 5: Verify the regression suite still passes**

Run: `node test-pdf-split.js`
Expected: `All pdf-split tests passed.` (confirms Task 1's module is unaffected; `server.js` isn't required by this test so it can't break it, but this re-run also catches an accidental edit to `lib/pdf-split.js` itself).

- [ ] **Step 6: Verify the structural shape of the change**

Run: `grep -n "validatePdfBuffer\|sendFileInParts\|MAX_PART_SIZE_BYTES" server.js`
Expected output includes all of:
- the `function validatePdfBuffer(buffer, filename)` definition
- `validatePdfBuffer(buffer, filename);` called once inside `uploadMedia` and once inside `sendDriveFile`
- the `const MAX_PART_SIZE_BYTES = 20 * 1024 * 1024;` definition
- the `async function sendFileInParts(to, buffer, filename, niceName) {` definition
- one call to `sendFileInParts(to, buffer, file.name, niceName)` inside `sendDriveFile`

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat(send-drive-file): split oversized PDFs into parts instead of failing silently"
```

---

### Task 3: `sendRule`'s document branch gets the same fix

**Files:**
- Modify: `server.js:995-1012` (`sendRule`'s `document` branch)

**Interfaces:**
- Consumes: `validatePdfBuffer(buffer, filename) -> void` and `sendFileInParts(to, buffer, filename, niceName) -> Promise<void>` from Task 2 (both defined in `server.js`, no import needed — same file).

- [ ] **Step 1: Rewrite the document branch**

Find this block (around line 995-1012):

```js
async function sendRule(to, rule) {
  if (rule.type === "document") {
    try {
      const mediaId = await uploadMedia({ link: rule.fileLink, filename: rule.filename });
      return send(to, {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: { id: mediaId, filename: rule.filename, caption: rule.caption },
      });
    } catch (err) {
      console.error("❌ Document upload error:", err.response?.data || err.message);
      return sendText(
        to,
        NOT_FOUND_MSG
      );
    }
  }
```

Replace it with:

```js
async function sendRule(to, rule) {
  if (rule.type === "document") {
    let buffer;
    try {
      buffer = await downloadBytes({ link: rule.fileLink });
      validatePdfBuffer(buffer, rule.filename);
    } catch (err) {
      console.error("❌ Document download error:", err.message);
      return sendText(to, NOT_FOUND_MSG);
    }
    try {
      const mediaId = await uploadMediaBuffer(buffer, rule.filename);
      return send(to, {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: { id: mediaId, filename: rule.filename, caption: rule.caption },
      });
    } catch (err) {
      if (err.response?.status === 413 && /\.pdf$/i.test(rule.filename)) {
        const niceName = rule.filename.replace(/\.[^.]+$/, "");
        return await sendFileInParts(to, buffer, rule.filename, niceName);
      }
      console.error("❌ Document upload error:", err.response?.data || err.message);
      return sendText(to, NOT_FOUND_MSG);
    }
  }
```

Leave the `if (rule.type === "image")` branch immediately below this block untouched.

- [ ] **Step 2: Verify syntax**

Run: `node -c server.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Verify the structural shape of the change**

Run: `grep -n "uploadMedia(" server.js`
Expected: exactly one remaining call — inside `sendRule`'s `image` branch (`uploadMedia({ link: rule.fileLink, filename: rule.filename || "image.jpg" })`). The `sendDriveFile` and `sendRule` document-branch calls to `uploadMedia` must no longer appear (both now call `downloadBytes` + `uploadMediaBuffer` directly).

- [ ] **Step 4: Re-run Task 1's regression test**

Run: `node test-pdf-split.js`
Expected: `All pdf-split tests passed.`

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(send-rule): split oversized rule-linked PDFs into parts instead of failing silently"
```

---

## Final acceptance check (not a subagent task — requires deploying and a real WhatsApp message)

After all three tasks are merged and deployed: send "Infinair profile" to the live bot. Expected: several sequential "... (Part i of N) 📄" document messages (the file is 119 MB; at a 20 MB budget this is at least 6 parts), instead of the plain "Cannot find requested file" message.
