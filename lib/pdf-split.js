// lib/pdf-split.js
// Splits an oversized PDF buffer into smaller, standalone PDF buffers by page
// range, so each part can be uploaded to WhatsApp separately when the whole
// document exceeds the platform's per-document size limit.
//
// Parts are delivered one at a time via `onPart`, never returned as an array.
// A production 119MB file OOM-killed a 1GB container because the previous
// array-returning version held the original buffer, the loaded pdf-lib
// source document, AND every output part simultaneously before the caller
// uploaded any of them. The callback shape lets the caller upload-and-drop
// each part before the next one is built.
'use strict';

const { PDFDocument } = require('pdf-lib');

// Calls onPart(partBuffer, index, total) once per part, in order (1-indexed),
// awaiting each call before building the next part. `total` is 1 and onPart
// is called exactly once with the original buffer when no splitting was
// possible or needed (under threshold, or a single page that's still over
// threshold) — callers must treat total === 1 for an over-threshold input as
// "could not split further."
async function splitPdfIntoParts(buffer, maxPartSizeBytes, onPart) {
  if (buffer.length <= maxPartSizeBytes) {
    await onPart(buffer, 1, 1);
    return;
  }

  const src = await PDFDocument.load(buffer);
  const totalPages = src.getPageCount();
  if (totalPages <= 1) {
    await onPart(buffer, 1, 1); // can't split a single page further
    return;
  }

  const numParts = Math.ceil(buffer.length / maxPartSizeBytes);
  const pagesPerPart = Math.ceil(totalPages / numParts);
  const actualNumParts = Math.ceil(totalPages / pagesPerPart);

  let index = 0;
  for (let start = 0; start < totalPages; start += pagesPerPart) {
    index++;
    const end = Math.min(start + pagesPerPart, totalPages);
    const indices = [];
    for (let i = start; i < end; i++) indices.push(i);

    const doc = await PDFDocument.create();
    const copiedPages = await doc.copyPages(src, indices);
    copiedPages.forEach((p) => doc.addPage(p));
    const partBuffer = Buffer.from(await doc.save());
    await onPart(partBuffer, index, actualNumParts);
  }
}

module.exports = { splitPdfIntoParts };
