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
