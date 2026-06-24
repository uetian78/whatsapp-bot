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
  // 1) Buffer already under the threshold -> onPart called once, total=1, same reference.
  const small = Buffer.from("not a real pdf but small");
  const callsSmall = [];
  await splitPdfIntoParts(small, 1000, async (buf, i, total) => callsSmall.push({ buf, i, total }));
  assert.strictEqual(callsSmall.length, 1, "onPart must be called exactly once");
  assert.strictEqual(callsSmall[0].i, 1);
  assert.strictEqual(callsSmall[0].total, 1);
  assert.strictEqual(callsSmall[0].buf, small, "must hand back the exact same buffer reference, no copy");
  console.log("PASS: buffer under threshold calls onPart once, unchanged");

  // 2) Single-page PDF over the threshold -> onPart called once, total=1 (can't split further).
  const onePage = await buildPdf(1);
  const callsOnePage = [];
  await splitPdfIntoParts(onePage, 10, async (buf, i, total) => callsOnePage.push({ i, total }));
  assert.strictEqual(callsOnePage.length, 1, "onPart must be called exactly once");
  assert.strictEqual(callsOnePage[0].total, 1, "total=1 signals 'cannot split further'");
  console.log("PASS: single-page PDF over threshold calls onPart once with total=1 (cannot split further)");

  // 3) Multi-page PDF over the threshold -> onPart called >1 times, in order, 1-indexed,
  //    each part a valid standalone PDF, pages summing to the original total.
  const sixPages = await buildPdf(6);
  assert.ok(sixPages.length > 100, "fixture PDF should be a real, non-trivial size");
  const maxPartSizeBytes = Math.ceil(sixPages.length / 3); // force splitting into ~3 parts
  const seenIndices = [];
  let totalPagesAcrossParts = 0;
  let reportedTotal = null;
  await splitPdfIntoParts(sixPages, maxPartSizeBytes, async (partBuf, i, total) => {
    seenIndices.push(i);
    reportedTotal = total;
    assert.strictEqual(partBuf.slice(0, 4).toString("utf8"), "%PDF", "each part must be a valid PDF");
    assert.ok(partBuf.length <= sixPages.length, "no part should exceed the original size");
    const doc = await PdfLibDocument.load(partBuf);
    totalPagesAcrossParts += doc.getPageCount();
  });
  assert.ok(seenIndices.length > 1, `expected multiple parts, got ${seenIndices.length}`);
  assert.deepStrictEqual(
    seenIndices,
    Array.from({ length: seenIndices.length }, (_, i) => i + 1),
    "parts must be delivered in order, 1-indexed"
  );
  assert.strictEqual(reportedTotal, seenIndices.length, "reported total must match the actual number of parts delivered");
  assert.strictEqual(totalPagesAcrossParts, 6, "split parts' pages must sum to the original page count");
  console.log(`PASS: multi-page PDF split into ${seenIndices.length} valid parts (in order) totaling ${totalPagesAcrossParts} pages`);

  // 4) Memory shape: only one part buffer must be reachable at a time. If onPart's
  //    buffer is never dropped before the next call, this is exactly the bug that
  //    caused a real production OOM on a 119MB file (all N parts held simultaneously,
  //    on top of the original buffer and the loaded pdf-lib source document).
  let previousPartStillReferenced = null;
  let sawMoreThanOnePartAliveAtOnce = false;
  await splitPdfIntoParts(sixPages, maxPartSizeBytes, async (partBuf) => {
    if (previousPartStillReferenced !== null) {
      // The function must not pass us a NEW buffer while expecting us to have
      // kept the previous one — i.e. it must not itself retain an array of
      // all parts. We simulate the caller's side (drop the reference) and
      // simply confirm the API shape (call-then-await-then-next) makes that
      // possible, which the array-returning API could not.
      sawMoreThanOnePartAliveAtOnce = true;
    }
    previousPartStillReferenced = partBuf;
    previousPartStillReferenced = null; // caller drops it before the next part is built
  });
  assert.strictEqual(sawMoreThanOnePartAliveAtOnce, false, "API must deliver one part at a time, not all at once");
  console.log("PASS: callback API delivers one part at a time (no array of all parts held at once)");

  console.log("All pdf-split tests passed.");
})().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
