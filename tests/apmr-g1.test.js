const test = require("node:test");
const assert = require("node:assert");
const { PRODUCTS } = require("../products.js");
const { parseListRequest, buildUnitList, PRODUCT_KB } = require("../product-facts.js");

test("APMRG1 has 19 models, T3-only capacity, G1 model names", () => {
  const p = PRODUCTS["apmr-g1"];
  assert.equal(p.models.length, 19);
  for (const m of p.models) {
    assert.ok(m.cap_kw > 0 && m.cap_tr > 0);
    assert.equal(m.t1_kw, undefined); // catalogue publishes no T1 rating
    assert.match(m.fullModel, /^APMR 5\d{4}G1$/);
  }
  assert.equal(p.models[0].fullModel, "APMR 51055G1");
});

test("list request routes APMR G1 spellings, without stealing APMR / APMR-A", () => {
  for (const q of ["list APMR G1 units", "apmrg1 models", "APMR-G1 range"])
    assert.deepEqual(parseListRequest(q), ["apmr-g1"], q);
  assert.deepEqual(parseListRequest("list APMR units"), ["apmr"]);
  assert.deepEqual(parseListRequest("list APMR-A units"), ["apmr-a"]);
  assert.equal(parseListRequest("APMR G1 catalogue"), null);
});

test("APMRG1 list shows T3 only, in both unit systems", () => {
  const imp = buildUnitList(["apmr-g1"], "imp");
  assert.match(imp, /APMR 52555G1 — 38\.7 TR — 15800 CFM — EER 7\.93/);
  assert.match(imp, /T3 \(46°C\)/);
  assert.doesNotMatch(imp, /T1/);
  assert.match(buildUnitList(["apmr-g1"], "si"), /APMR 51055G1 — 13\.7 kW — 802 L\/s/);
  assert.match(PRODUCT_KB, /APMR 52300G1: net cooling at T3\(46°C\) only/);
});
