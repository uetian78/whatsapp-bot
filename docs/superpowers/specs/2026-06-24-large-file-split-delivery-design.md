# Split Oversized PDFs for WhatsApp Delivery

**Date:** 2026-06-24
**Status:** Approved (design)
**Component:** `server.js` (file delivery), new `lib/pdf-split.js`

## Problem

`uploadMedia` downloads a Drive file's bytes, then POSTs them to Meta's
WhatsApp media-upload endpoint. When the file exceeds Meta's per-document
size limit, that POST fails with HTTP 413 ("Payload Too Large"). Both
callers — `sendDriveFile` (`server.js:951`) and `sendRule`'s document branch
(`server.js:995`) — catch this the same way as every other upload failure
and reply with the plain `NOT_FOUND_MSG` ("Cannot find requested file").

This is misleading: the file genuinely exists and was located correctly —
delivery failed for an unrelated reason (size), not a lookup miss. Confirmed
in production logs for "Infinair Profile.pdf" (119 MB, found on the first
exact-filename match, upload rejected with 413).

## Goal

When a located file is too large to upload as a single WhatsApp document,
split it into page-range parts that each fit comfortably under the limit,
and send them as sequential numbered messages ("Part 1 of 3", etc.), instead
of silently substituting the generic not-found message.

## Decisions (from brainstorming)

- **Scope:** general, permanent bot capability — not a one-off fix for this
  one file. Applies to both `sendDriveFile` and `sendRule`'s document
  branch, since both share the same `uploadMedia` upload path and the same
  413 risk.
- **Trigger:** reactive, not proactive. Keep the existing single-file upload
  attempt as the fast path (the overwhelming majority of files are well
  under the limit and succeed immediately) — no upfront Drive size-metadata
  call added to every file send. Only on catching HTTP 413 from the upload
  POST do we fall into the split-and-resend path, reusing the buffer already
  downloaded for the failed attempt (no re-download).
- **Splitting strategy:** split only `.pdf` files; PDF is the only format
  with a general-purpose splitting strategy here. Non-PDF oversized files
  (e.g. an `.html` selection tool) have no splitting strategy and fall back
  to the existing plain message, unchanged.
- **Why splitting, not compression:** the file (119 MB) already exceeds
  Meta's documented 100 MB hard cap for documents — no upload method
  delivers it as a single message regardless of mechanism. Real PDF
  compression (recompressing embedded images) needs an external tool
  (e.g. Ghostscript) not present in this codebase or Docker image, and its
  size reduction is unpredictable. Splitting via page ranges needs only a
  small pure-JS library (`pdf-lib`), is deterministic, and has no quality
  loss.
- **Part size target:** 20 MB per part — a conservative margin under Meta's
  100 MB cap, in case the simple (non-resumable) upload endpoint enforces a
  stricter practical limit than the documented per-file-type maximum.
- **Order:** parts are sent sequentially (awaited one at a time), not in
  parallel, so they arrive in order.
- **Un-splittable case:** if the PDF has only one page (or otherwise can't
  be reduced under the target via page splitting — e.g. a single huge
  embedded image), there is no way to shrink it further. Fall back to the
  existing plain not-found-style message rather than attempting a send that
  would fail again.

## Architecture

### 1. `lib/pdf-split.js` — new file

```
splitPdfIntoParts(buffer, maxPartSizeBytes) -> Promise<Buffer[]>
```

- If `buffer.length <= maxPartSizeBytes`, returns `[buffer]` unchanged (no
  work done).
- Otherwise: `numParts = Math.ceil(buffer.length / maxPartSizeBytes)`.
  Loads the PDF via `pdf-lib`'s `PDFDocument.load`. If the document has only
  one page, returns `[buffer]` unchanged (cannot split a single page) —
  callers must treat a single-element return for an over-threshold input as
  "could not split."
  Otherwise divides pages evenly across `numParts` parts
  (`pagesPerPart = Math.ceil(totalPages / numParts)`), building each part as
  a fresh `PDFDocument` via `copyPages`/`addPage`, and returns one `Buffer`
  per part (via `doc.save()`).
- This is page-count-based, not exact-byte-based: pages are not guaranteed
  to be uniform in size, so a part is not guaranteed to be exactly under
  `maxPartSizeBytes` — the 20 MB target (vs. the 100 MB real cap) exists
  precisely to absorb this slack.

### 2. `validatePdfBuffer(buffer, filename)` — new small helper (`server.js`)

Extracts the existing inline PDF-signature sanity check currently inside
`uploadMedia` (mime-sniff via `mimeFromName`, then confirm the buffer starts
with `%PDF` when the mime is `application/pdf`) into a standalone helper, so
both `sendDriveFile` and `sendRule`'s document branch can call it after
downloading bytes themselves.

`uploadMedia` itself is left unchanged and keeps serving its one remaining
caller, `sendRule`'s **image** branch (`server.js:1015`) — images are not
split (see Decisions), so that path has no need to hold onto the downloaded
buffer and doesn't change.

### 3. `sendFileInParts(to, buffer, filename, niceName)` — new shared helper

- Calls `splitPdfIntoParts(buffer, MAX_PART_SIZE_BYTES)`
  (`MAX_PART_SIZE_BYTES = 20 * 1024 * 1024`).
- If it returns a single part (un-splittable), logs and sends the existing
  plain not-found-style message.
- Otherwise, for each part in order: uploads via `uploadMediaBuffer`, then
  sends it as a WhatsApp document with filename
  `"<niceName> (Part i of N).pdf"` and caption
  `"Here is <niceName> (Part i of N) 📄"`.
- Any failure during this path (split error, upload error on any part) logs
  and falls back to the plain not-found-style message.

### 4. `sendDriveFile` (`server.js:951`) — modified

- For the non-image (document) case: calls `downloadBytes({ fileId: file.id
  })` directly (no longer goes through `uploadMedia`), then
  `validatePdfBuffer`, then `uploadMediaBuffer(buffer, file.name)`.
- On a caught error: if `err.response?.status === 413` and the filename ends
  in `.pdf`, calls `sendFileInParts`. Otherwise, unchanged — falls back to
  the plain not-found-style message.
- The image case (`isImage`) is untouched and still goes through
  `uploadMedia` as today.

### 5. `sendRule`'s document branch (`server.js:995`) — modified

- Same pattern as `sendDriveFile`: `downloadBytes({ link: rule.fileLink })`
  directly, `validatePdfBuffer`, `uploadMediaBuffer(buffer, rule.filename)`.
  On 413 (and a `.pdf` filename), call the same shared `sendFileInParts`.
  Otherwise unchanged. The image branch (`server.js:1013`) is untouched.

### 6. `package.json` — add `pdf-lib` dependency

Used only by `lib/pdf-split.js`. `pdfkit` (already a dependency) generates
new PDFs from scratch and cannot load/split existing ones — a different
job.

## Explicitly out of scope

- Compression of existing PDFs (see Decisions above).
- Meta's resumable/chunked upload API for delivering a single oversized
  file as one message — doesn't apply here since 119 MB already exceeds the
  platform's flat 100 MB per-document cap regardless of upload mechanism.
- Splitting non-PDF documents (no general strategy available).
- Splitting PDFs generated locally by `pdfkit` (`mtz-pdf.js`,
  `schedule-pdf.js`, `split-pdf.js`, `sendPdfBuffer`/`sendDocument`) — these
  are built from selection data and are not a realistic size risk; not
  touched by this change.
- Manually compressing or replacing the specific "Infinair Profile.pdf" file
  on Drive — out of scope per the chosen "build it into the bot
  permanently" direction; the bot will handle it automatically once this
  ships.

## Testing

- `lib/pdf-split.js` unit tests (`test-pdf-split.js`):
  - Buffer already under `maxPartSizeBytes` → returns `[buffer]` unchanged,
    untouched by pdf-lib.
  - Single-page PDF over `maxPartSizeBytes` → returns `[buffer]` unchanged
    (the "can't split further" case).
  - Multi-page PDF over `maxPartSizeBytes` (built in-memory with `pdfkit`,
    each page embedding enough content to produce a real, predictable
    multi-megabyte size) → returns `> 1` parts; every part is a valid PDF
    (starts with `%PDF`); the parts' page counts sum to the original page
    count; no part exceeds the original total size.
- Manual/integration: re-test "Infinair profile" against the live bot once
  deployed — expect several "Part i of N" document messages instead of the
  plain not-found message.
