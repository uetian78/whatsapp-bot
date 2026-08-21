const test = require("node:test");
const assert = require("node:assert");
const {
  meaningfulTokens, hasSearchableExtras, rankFiles, isSearchAllTrigger,
} = require("../lib/broad-search.js");

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
