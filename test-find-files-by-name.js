const assert = require("node:assert");
const { findFilesByName } = require("./lib/find-files-by-name.js");

const files = [
  { name: "SKM Profile.pdf" },
  { name: "Toshiba Profile.pdf" },
  { name: "TCL Company Profile.pdf" },
  { name: "APMR_catalogue.pdf" },
  { name: "APMR-A. 2025_catalogue.pdf" },
];

// Regression: exact match (rank 0)
assert.deepStrictEqual(
  findFilesByName("SKM Profile", files).map((f) => f.name),
  ["SKM Profile.pdf"]
);

// Regression: query inside filename (rank 1)
assert.deepStrictEqual(
  findFilesByName("apmr", files).map((f) => f.name).sort(),
  ["APMR-A. 2025_catalogue.pdf", "APMR_catalogue.pdf"]
);

// Regression: filename inside query (rank 2)
assert.deepStrictEqual(
  findFilesByName("please send me the apmr catalogue pdf", files).map((f) => f.name),
  ["APMR_catalogue.pdf"]
);

// Regression: no match at all
assert.deepStrictEqual(findFilesByName("completely unrelated text", files), []);

// Bug fix: an extra word inserted between the filename's words ("company")
// must not break the match — every word of "SKM Profile" is present
// somewhere in "SKM company profile", just not contiguously.
assert.deepStrictEqual(
  findFilesByName("SKM company profile", files).map((f) => f.name),
  ["SKM Profile.pdf"]
);

// No false positive: the token fallback must not also pull in other
// "profile" documents that don't share ALL of their words with the query.
assert.ok(
  !findFilesByName("SKM company profile", files).some((f) => f.name === "Toshiba Profile.pdf"),
  "should not match Toshiba Profile.pdf — \"toshiba\" isn't in the query"
);
assert.ok(
  !findFilesByName("SKM company profile", files).some((f) => f.name === "TCL Company Profile.pdf"),
  "should not match TCL Company Profile.pdf — \"tcl\" isn't in the query"
);

console.log("All find-files-by-name tests passed.");
