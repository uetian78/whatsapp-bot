const test = require("node:test");
const assert = require("node:assert");
const {
  meaningfulTokens, hasSearchableExtras, rankFiles,
  isSearchAllTrigger, isAiSearchTrigger,
} = require("../lib/broad-search.js");
const { isIndexableFile, displayName } = require("../lib/drive-index.js");

// A slice of the real Drive layout (folder names taken from the live index
// dump), plus the coil connection sheet this feature exists to find.
const FILES = [
  { id: "1", name: "FCU Coil Connection Sheet.pdf", folder: "Submittal Files/07 - Coil Connection" },
  { id: "2", name: "FCU_catalogue.pdf", folder: "Catalogues" },
  { id: "3", name: "FCU_IOM.pdf", folder: "IOM" },
  { id: "4", name: "SKM AHRI Coil Certificates (1).pdf", folder: "Submittal Files/10 - Test Certificates/SKM AHRI Coil Certificates - MAH, APMR, APMRA, DMP,DYP, FCU" },
  { id: "5", name: "GSAS-Split Unit Submittal_.pdf", folder: "Submittal Files/14 - Previous Project Approvals/Toshiba Splits (Hi wall - Ducted) - Previous Approval" },
  { id: "6", name: "APMR-A.pdf", folder: "Catalogues" },
  { id: "7", name: "Mannai Company Profile.pdf", folder: "Submittal Files/01 - Company Profile (Mannai Trading)" },
];

test("doc-type words and filler are not treated as search signal", () => {
  assert.deepEqual(meaningfulTokens("fcu catalogue pdf please"), ["fcu"]);
  assert.deepEqual(meaningfulTokens("send me the APMR IOM"), ["apmr"]);
  // The words that matter for this bug must survive.
  assert.deepEqual(meaningfulTokens("fcu coil connection sheet"),
    ["fcu", "coil", "connection", "sheet"]);
});

// The reported bug: "fcu" alone is a menu request, but "fcu coil connection
// sheet" is a search and must not be reduced to the series name.
test("a bare series is a menu request; extra words make it a search", () => {
  assert.equal(hasSearchableExtras("fcu", "FCU"), false);
  assert.equal(hasSearchableExtras("fcu pdf", "FCU"), false, "doc words are not extras");
  assert.equal(hasSearchableExtras("FCU  ", "FCU"), false);
  assert.equal(hasSearchableExtras("fcu coil connection sheet", "FCU"), true);
  assert.equal(hasSearchableExtras("apmr previous approvals", "APMR"), true);
});

test("multi-token series names are not mistaken for extras", () => {
  assert.equal(hasSearchableExtras("apmr-a", "APMR-A"), false);
  assert.equal(hasSearchableExtras("apmr a catalogue", "APMR-A"), false);
});

test("the reported query ranks the coil connection sheet first", () => {
  const hits = rankFiles("fcu coil connection sheet", FILES);
  assert.equal(hits[0].name, "FCU Coil Connection Sheet.pdf");
});

// The folder path is part of the haystack — that is what lets a query find a
// file whose name alone would not match.
test("folder names contribute to the match", () => {
  const hits = rankFiles("coil connection", FILES);
  assert.equal(hits[0].name, "FCU Coil Connection Sheet.pdf");

  const approvals = rankFiles("toshiba previous approval", FILES);
  assert.equal(approvals[0].name, "GSAS-Split Unit Submittal_.pdf");
});

test("a vague query still surfaces plausible candidates to choose from", () => {
  const hits = rankFiles("fcu coil", FILES);
  const names = hits.map((f) => f.name);
  assert.ok(names.includes("FCU Coil Connection Sheet.pdf"));
  assert.ok(names.includes("SKM AHRI Coil Certificates (1).pdf"),
    "the certificates are a reasonable thing to offer for 'fcu coil'");
});

// A 3+ word query must not return every file sharing one common word.
test("weak one-word overlap is filtered out of a long query", () => {
  const names = rankFiles("fcu coil connection sheet", FILES).map((f) => f.name);
  assert.ok(!names.includes("Mannai Company Profile.pdf"));
  assert.ok(!names.includes("APMR-A.pdf"));
});

test("results are capped and ordered best-first", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    id: String(i), name: `FCU Coil Doc ${i}.pdf`, folder: "Submittal Files",
  }));
  assert.equal(rankFiles("fcu coil", many, 10).length, 10);
  assert.equal(rankFiles("fcu coil", many, 3).length, 3);
});

test("an all-noise query returns nothing rather than everything", () => {
  assert.deepEqual(rankFiles("please send me the pdf", FILES), []);
  assert.deepEqual(rankFiles("", FILES), []);
  assert.deepEqual(rankFiles("fcu", null), []);
});

test("search-all trigger matches its phrasings and nothing else", () => {
  for (const t of ["search all", "Search All", "search all files",
                   "search everything", "search drive", "  search all  "]) {
    assert.equal(isSearchAllTrigger(t), true, `${JSON.stringify(t)} should trigger`);
  }
  for (const t of ["search all fcu files", "fcu coil connection sheet", "search", ""]) {
    assert.equal(isSearchAllTrigger(t), false, `${JSON.stringify(t)} should not trigger`);
  }
});

test("ai-search trigger matches its phrasings and nothing else", () => {
  for (const t of ["ai search", "AI Search", "search ai", "search with ai",
                   "deep search", "ask ai", "  ai search  "]) {
    assert.equal(isAiSearchTrigger(t), true, `${JSON.stringify(t)} should trigger`);
  }
  for (const t of ["ai search for fcu", "search all", "ai", ""]) {
    assert.equal(isAiSearchTrigger(t), false, `${JSON.stringify(t)} should not trigger`);
  }
});

// The two escape hatches must stay distinct — "search all" is free, "ai
// search" costs a call, and one must never fire for the other's phrasing.
test("the free and AI triggers never overlap", () => {
  for (const t of ["search all", "search everything", "search drive"]) {
    assert.equal(isSearchAllTrigger(t), true);
    assert.equal(isAiSearchTrigger(t), false);
  }
  for (const t of ["ai search", "deep search", "ask ai"]) {
    assert.equal(isAiSearchTrigger(t), true);
    assert.equal(isSearchAllTrigger(t), false);
  }
});

// The actual root cause of the reported bug: the file is a spreadsheet, and
// the index only ever collected PDFs and images.
test("spreadsheets, Word docs and native Google files are all indexed", () => {
  assert.equal(isIndexableFile({ name: "FCU Coil Connection Sheet.xlsx" }), true);
  assert.equal(isIndexableFile({ name: "FCU Coil Connection Sheet.xls" }), true);
  assert.equal(isIndexableFile({ name: "Draft Warranty.docx" }), true);
  assert.equal(isIndexableFile({ name: "APMR-A.pdf" }), true);
  assert.equal(isIndexableFile({ name: "cert.jpeg" }), true);

  // Native Google files ARE indexed — they're rendered via files.export on
  // the way out, which is how the reported spreadsheet becomes reachable.
  assert.equal(isIndexableFile({ name: "Coil Sheet", mimeType: "application/vnd.google-apps.spreadsheet" }), true);
  assert.equal(isIndexableFile({ name: "Warranty", mimeType: "application/vnd.google-apps.document" }), true);

  // Not sendable / not a document.
  assert.equal(isIndexableFile({ name: "notes.txt" }), false);
  assert.equal(isIndexableFile({ name: "Sub", mimeType: "application/vnd.google-apps.folder" }), false);
  assert.equal(isIndexableFile(null), false);
});

test("display name drops the extension for every indexed type", () => {
  assert.equal(displayName({ name: "FCU Coil Connection Sheet.xlsx" }), "FCU Coil Connection Sheet");
  assert.equal(displayName({ name: "Draft Warranty.docx" }), "Draft Warranty");
  assert.equal(displayName({ name: "APMR-A_catalogue.pdf" }), "APMR-A");
});

// The spreadsheet must be findable by the free scan once indexed.
test("an indexed spreadsheet is findable by the free ranked scan", () => {
  const files = [
    { id: "x", name: "FCU Coil Connection Sheet.xlsx", folder: "Submittal Files/07 - Coil Connection" },
    { id: "y", name: "FCU_catalogue.pdf", folder: "Catalogues" },
  ];
  assert.equal(rankFiles("fcu coil connection sheet", files)[0].name,
    "FCU Coil Connection Sheet.xlsx");
});

// The reported file is a NATIVE Google Sheet: created in Drive, so it has no
// stored bytes and no file extension. A plain download 403s — it has to be
// rendered via files.export first.
test("native Google files are indexed and given a real filename", () => {
  const { toIndexRecord } = require("../lib/drive-index.js");

  const sheet = toIndexRecord(
    { id: "abc", name: "FCU Coil Connection Sheet",
      mimeType: "application/vnd.google-apps.spreadsheet" },
    "Submittal Files"
  );
  assert.equal(sheet.name, "FCU Coil Connection Sheet.xlsx",
    "extension is appended so mime lookup and matching work");
  assert.equal(sheet.exportMime,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(sheet.folder, "Submittal Files");

  const doc = toIndexRecord(
    { id: "d", name: "Draft Warranty", mimeType: "application/vnd.google-apps.document" }, "x");
  assert.equal(doc.name, "Draft Warranty.docx");

  const deck = toIndexRecord(
    { id: "p", name: "Company Intro", mimeType: "application/vnd.google-apps.presentation" }, "x");
  assert.equal(deck.name, "Company Intro.pptx");
});

test("uploaded files are recorded unchanged, with no exportMime", () => {
  const { toIndexRecord } = require("../lib/drive-index.js");
  const pdf = toIndexRecord({ id: "1", name: "APMR-A.pdf", mimeType: "application/pdf" }, "Catalogues");
  assert.deepEqual(pdf, { id: "1", name: "APMR-A.pdf", folder: "Catalogues" });
  assert.equal(pdf.exportMime, undefined, "a plain download must not be exported");
});

test("a native Google Sheet is now indexable, searchable and displayed cleanly", () => {
  const { isIndexableFile, toIndexRecord, displayName } = require("../lib/drive-index.js");
  const raw = { id: "abc", name: "FCU Coil Connection Sheet",
                mimeType: "application/vnd.google-apps.spreadsheet" };

  assert.equal(isIndexableFile(raw), true);

  const rec = toIndexRecord(raw, "Submittal Files");
  assert.equal(displayName(rec), "FCU Coil Connection Sheet", "extension hidden from the user");

  // The query from the bug report must find it.
  assert.equal(rankFiles("fcu coil connection sheet", [rec])[0].name,
    "FCU Coil Connection Sheet.xlsx");
});
