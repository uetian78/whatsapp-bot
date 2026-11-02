const test = require("node:test");
const assert = require("node:assert");
const { parseArgs } = require("../scripts/build-index.js");

test("by default the build uploads, and --no-upload turns that off", () => {
  assert.equal(parseArgs([]).upload, true);
  assert.equal(parseArgs(["--no-upload"]).upload, false);
});

test("--limit builds a partial file, so it never uploads, and says so", () => {
  const o = parseArgs(["--limit", "5"]);
  assert.equal(o.limit, 5);
  assert.equal(o.upload, false);
  assert.equal(o.limitImpliedNoUpload, true);
  assert.equal(parseArgs(["--limit", "5", "--no-upload"]).upload, false);
});

test("a bad --limit or an unknown option is refused", () => {
  assert.throws(() => parseArgs(["--limit", "0"]), /whole number/);
  assert.throws(() => parseArgs(["--nope"]), /Unknown option/);
});
