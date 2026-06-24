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
