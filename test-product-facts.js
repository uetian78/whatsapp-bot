// Tests for the product knowledge base (product-facts.js).
// Guards that known datasheet figures are present and correctly formatted, so
// the AI always has real numbers to answer "Quick Questions" from.

const { PRODUCT_KB, parseListRequest, buildUnitList } = require("./product-facts.js");
const { PRODUCTS } = require("./products.js");
const chillers = require("./chillers.js");

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log("  ✅", label); } else { fail++; console.log("  ❌", label); } };

console.log("PRODUCT_KB coverage");
ok("is a non-trivial string", typeof PRODUCT_KB === "string" && PRODUCT_KB.length > 5000);
ok("explains T1/T3 notation", /T1 = 35°C/.test(PRODUCT_KB) && /T3 = 46°C/.test(PRODUCT_KB));

// One known line from each family (exact figures from products.js / chillers.js).
ok("APMR 52340 T3 capacity present", /APMR 52340: .*T3\(46°C\)=24\.9 TR \(87\.6 kW\)/.test(PRODUCT_KB));
ok("APMR-A 51004 present", /APMR 51004A: /.test(PRODUCT_KB));
ok("PAC4A fresh-air present", /PAC4A 52015: cooling .* at 46\.1°C/.test(PRODUCT_KB));
ok("DMP-10 3-row present", /DMP-10\/30\/WG: 3-row coil/.test(PRODUCT_KB));
ok("DCMP present", /DCMP-/.test(PRODUCT_KB));
ok("a chiller with EER present", /APCY\w+ \(APCY-[EH]\): .* EER /.test(PRODUCT_KB));

console.log("every model appears in the KB");
let allPackaged = 0, missing = 0;
for (const key of ["apmr", "apmr-a", "pac4a", "fcu-dmp", "fcu-dcmp"]) {
  for (const m of PRODUCTS[key].models) {
    allPackaged++;
    if (!PRODUCT_KB.includes(m.fullModel)) { missing++; console.log("    missing:", m.fullModel); }
  }
}
ok(`all ${allPackaged} products/FCU models listed`, missing === 0);

let chMissing = 0;
for (const m of (chillers.MODELS || [])) if (!PRODUCT_KB.includes(m.model)) chMissing++;
ok(`all ${(chillers.MODELS || []).length} chiller models listed`, chMissing === 0);

console.log("parseListRequest detection");
ok('"give me list of APMR units" -> apmr', JSON.stringify(parseListRequest("give me list of APMR units")) === '["apmr"]');
ok('"list all APMR-A models" -> apmr-a', JSON.stringify(parseListRequest("list all APMR-A models")) === '["apmr-a"]');
ok('"list PAC4A" -> pac4a', JSON.stringify(parseListRequest("list PAC4A")) === '["pac4a"]');
ok('"list fcu" -> both FCU', JSON.stringify(parseListRequest("list fcu")) === '["fcu-dmp","fcu-dcmp"]');
ok('"what chillers do you have" -> both APCY', JSON.stringify(parseListRequest("what chillers do you have")) === '["chiller:APCY-E","chiller:APCY-H"]');
ok('"APMR catalogue" is NOT a list', parseListRequest("APMR catalogue") === null);
ok('"APMR 20 tr" (selection) is NOT a list', parseListRequest("APMR 20 tr") === null);
ok('"APMRa 51004" (model) is NOT a list', parseListRequest("APMRa 51004") === null);

console.log("buildUnitList content");
const apmrList = buildUnitList(parseListRequest("list APMR units"));
ok("APMR list has all 15 models", PRODUCTS.apmr.models.every((m) => apmrList.includes(m.fullModel)));
ok("APMR list shows TR and CFM", /28\.1 \/ 24\.9 TR — 10500 CFM/.test(apmrList));
ok("APMR list shows model count", /15 models/.test(apmrList));
const dmpList = buildUnitList(["fcu-dmp"]);
ok("DMP list groups 3-row / 4-row", /DMP-10 — 3-row .* \/ 4-row .* TR/.test(dmpList));
const chList = buildUnitList(["chiller:APCY-H"]);
ok("Chiller list shows TR + EER", /APCY\w+DH — [\d.]+ TR — EER [\d.]+/.test(chList));
ok("every list stays under WhatsApp limit", ["apmr", "apmr-a", "pac4a", "fcu-dmp", "fcu-dcmp"].every((k) => buildUnitList([k]).length < 4096));

console.log(`\n${fail === 0 ? "✅ All product-facts checks passed" : "❌ " + fail + " FAILED"} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
