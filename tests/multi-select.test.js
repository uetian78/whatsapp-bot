const test = require("node:test");
const assert = require("node:assert");
const { parseSelection } = require("../lib/multi-select.js");

const pick = (text, max = 6) => parseSelection(text, max);

test("a single number still works exactly as before", () => {
  assert.deepEqual(pick("2").indices, [1]);
  assert.deepEqual(pick("1").indices, [0]);
  assert.equal(pick("2").all, false);
});

test("several numbers, any common separator", () => {
  for (const t of ["1,3,5", "1 3 5", "1, 3, 5", "1;3;5", "1 and 3 and 5", "1,3 5"]) {
    assert.deepEqual(pick(t).indices, [0, 2, 4], `failed on ${JSON.stringify(t)}`);
  }
});

test("ranges, and ranges mixed with singles", () => {
  assert.deepEqual(pick("1-3").indices, [0, 1, 2]);
  assert.deepEqual(pick("2-4").indices, [1, 2, 3]);
  assert.deepEqual(pick("1-2, 5").indices, [0, 1, 4]);
  // Backwards range is a typo, not an error — read it the sensible way.
  assert.deepEqual(pick("3-1").indices, [0, 1, 2]);
});

test("results are deduped and ordered regardless of input order", () => {
  assert.deepEqual(pick("5,1,3,1,5").indices, [0, 2, 4]);
  assert.deepEqual(pick("3-5, 4").indices, [2, 3, 4]);
});

test("'all' selects everything on offer", () => {
  const r = pick("all", 4);
  assert.deepEqual(r.indices, [0, 1, 2, 3]);
  assert.equal(r.all, true);
  for (const t of ["ALL", "all files", "all documents", "send all", "everything"]) {
    assert.equal(pick(t, 3).all, true, `failed on ${JSON.stringify(t)}`);
  }
});

test("out-of-range numbers are reported, not silently dropped", () => {
  const r = pick("2, 9, 12", 6);
  assert.deepEqual(r.indices, [1]);
  assert.deepEqual(r.invalid, [9, 12]);
});

// The parser sits in front of normal message routing, so anything that isn't
// a pick MUST return null or it will swallow real queries.
test("non-selections fall through to the router", () => {
  for (const t of ["fcu coil connection sheet", "apmr catalogue", "menu",
                   "search all", "hi", "", "   ", "1a", "-", "the 3rd one"]) {
    assert.equal(pick(t), null, `${JSON.stringify(t)} must not be treated as a pick`);
  }
});

test("a pick is capped so one reply can't trigger dozens of uploads", () => {
  const r = parseSelection("1-40", 40, { cap: 10 });
  assert.equal(r.indices.length, 10);
  assert.equal(r.capped, true);

  const all = parseSelection("all", 25, { cap: 10 });
  assert.equal(all.indices.length, 10);
  assert.equal(all.capped, true);

  const small = parseSelection("1-3", 20, { cap: 10 });
  assert.equal(small.capped, false);
});

test("guards against a missing or empty candidate list", () => {
  assert.equal(parseSelection("1", 0), null);
  assert.equal(parseSelection("1", undefined), null);
  assert.equal(parseSelection(null, 5), null);
});
