const test = require("node:test");
const assert = require("node:assert");
const XLSX = require("xlsx");

test("xlsx reads back a workbook it wrote", () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Room", "kW"], ["A", 5]]), "S");
  const back = XLSX.read(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  assert.equal(back.Sheets.S.B2.v, 5);
});
