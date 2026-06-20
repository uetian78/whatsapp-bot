const assert = require("node:assert");
const { findBrandDocs } = require("./brand-docs.js");

// Toshiba Split: was files: [], now resolves to the real catalogue
const toshibaSplit = findBrandDocs("toshiba catalogue");
assert.ok(toshibaSplit.length >= 1, "toshiba catalogue should match something");
assert.ok(
  toshibaSplit.some((m) => m.file.filename === "Toshiba Hi Wall Split PKCV and Ducted Split BSP - Catalogue.pdf"),
  "should resolve to the real Toshiba split catalogue"
);

// TCL Split: catalogue intent
const tclCat = findBrandDocs("tcl catalogue");
assert.ok(
  tclCat.some((m) => m.file.filename === "TCL - Hi Wall Split Units Catalogue - ZGI.pdf"),
  "should resolve to the real TCL catalogue"
);

// TCL Split: IOM intent (new keyword)
const tclIom = findBrandDocs("tcl iom");
assert.ok(
  tclIom.some((m) => m.file.filename === "TCL Hi Wall Splits IOM.pdf"),
  "tcl iom should resolve to the TCL IOM"
);

// New: Toshiba VRF SMMSe
const smmse = findBrandDocs("toshiba vrf catalogue");
assert.ok(
  smmse.some((m) => m.file.filename === "Toshiba VRF SMMSe Catalogue.pdf"),
  "toshiba vrf catalogue should resolve to the SMMSe catalogue"
);

// No collision: a VRF-specific ask should not also pull in the split catalogue
assert.ok(
  !smmse.some((m) => m.file.filename === "Toshiba Hi Wall Split PKCV and Ducted Split BSP - Catalogue.pdf"),
  "toshiba vrf catalogue should not match the Toshiba Split entry"
);

// No collision: a bare split ask should not pull in the VRF catalogue
const generic = findBrandDocs("toshiba catalogue");
assert.ok(
  !generic.some((m) => m.file.filename === "Toshiba VRF SMMSe Catalogue.pdf"),
  "toshiba catalogue (no vrf) should not match the SMMSe entry"
);

console.log("All brand-docs.js tests passed.");
