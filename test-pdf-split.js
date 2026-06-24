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
