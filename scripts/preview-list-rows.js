// Print the interactive-list rows the bot would send, so titles and folder
// descriptions can be eyeballed before deploying.
//
//   node scripts/preview-list-rows.js
//
// Uses the real payload builder, so what you see here is what WhatsApp gets,
// including its hard limits (10 rows, title 24 chars, description 72).
const { displayName, shortPath } = require("../lib/drive-index.js");
const { buildListPayload } = require("../lib/wa.js");
const { rankFiles } = require("../lib/broad-search.js");

// Folder paths below are taken from the live /drive-index output.
const INDEX = [
  { id: "a1", name: "FCU Coil Connection Sheet.xlsx", folder: "Submittal Files" },
  { id: "a2", name: "SKM AHRI Coil Certificates (1).pdf", folder: "Submittal Files/10 - Test Certificates/SKM AHRI Coil Certificates - MAH, APMR, APMRA, DMP,DYP, FCU" },
  { id: "a3", name: "SKM AHRI Coil Certificates (2).pdf", folder: "Submittal Files/10 - Test Certificates/SKM AHRI Coil Certificates - MAH, APMR, APMRA, DMP,DYP, FCU" },
  { id: "a4", name: "SKM AHU Compliance QCS.xlsx", folder: "Submittal Files/05 - Compliance Specifications / QCS" },
  { id: "a5", name: "APMR-A. 2025_catalogue.pdf", folder: "Catalogues" },
  { id: "a6", name: "APMRA 2025 IOM_IOM.pdf", folder: "IOM" },
  { id: "a7", name: "APMRA 51004 A - T1.pdf", folder: "Datasheets/APMR-A Selections" },
  { id: "a8", name: "APMRA 51004 A - T3.pdf", folder: "Datasheets/APMR-A Selections" },
  { id: "a9", name: "Organization Chart - Mannai.pdf", folder: "Submittal Files" },
  { id: "a10", name: "SKM FCU Previous Approval Compilation Document.pdf", folder: "Submittal Files/14 - Previous Project Approvals/SKM FCUs - Previous Approvals" },
  { id: "b1", name: "Toshiba ISO 9001 Certificate.pdf", folder: "Submittal Files/11 - ISO Certificates" },
  { id: "b2", name: "Toshiba ISO 14001 Certificate.pdf", folder: "Submittal Files/11 - ISO Certificates" },
  { id: "b3", name: "Toshiba ISO 45001 Certificate.pdf", folder: "Submittal Files/11 - ISO Certificates" },
];

function rowsFor(files) {
  const rows = files.map((f) => ({
    id: `fileid|${f.id}`,
    title: displayName(f).slice(0, 24),
    description: shortPath(f.folder),
  }));
  if (files.length >= 2 && rows.length < 10) {
    rows.push({
      id: "sendall",
      title: `📦 Send all ${files.length}`,
      description: "Get every document above in one go",
    });
  }
  return rows;
}

function show(query) {
  const hits = rankFiles(query, INDEX, 10);
  console.log(`\n${"=".repeat(78)}\nQuery: "${query}"  ->  ${hits.length} row(s)\n${"=".repeat(78)}`);
  if (!hits.length) return console.log("  (no matches)");

  // Round-trip through the real payload builder so truncation is authentic.
  const payload = buildListPayload("974xxxxxxxx", "I found several matches:", "Choose a document", rowsFor(hits));
  for (const r of payload.interactive.action.sections[0].rows) {
    console.log(`\n  title (${String(r.title.length).padStart(2)}/24)  ${r.title}`);
    console.log(`  desc  (${String((r.description || "").length).padStart(2)}/72)  ${r.description || "(none)"}`);
  }
}

show("toshiba iso certificates");
show("fcu coil connection sheet");
show("coil certificates");
show("apmra 51004");
show("compliance qcs");

// Edge cases for the truncation rule.
console.log(`\n${"=".repeat(78)}\nshortPath() edge cases\n${"=".repeat(78)}`);
const cases = [
  "Submittal Files",
  "Catalogues",
  "Datasheets/APMR-A Selections",
  "Submittal Files/10 - Test Certificates/SKM AHRI Coil Certificates - MAH, APMR, APMRA, DMP,DYP, FCU",
  "Submittal Files/14 - Previous Project Approvals/SKM FCUs - Previous Approvals",
  "(root)",
  "",
];
for (const c of cases) {
  const out = shortPath(c);
  console.log(`\n  in  (${String(c.length).padStart(3)})  ${c || "(empty)"}`);
  console.log(`  out (${String(out.length).padStart(3)})  ${out || "(empty)"}`);
}

// ---- What a text reply resolves to ----
const { parseSelection } = require("../lib/multi-select.js");
console.log(`\n${"=".repeat(78)}\nText replies against a 6-document list\n${"=".repeat(78)}`);
for (const reply of ["2", "1,3,5", "1-4", "all", "3 and 5", "2, 99", "1-40",
                     "fcu coil connection sheet"]) {
  const r = parseSelection(reply, 6, { cap: 10 });
  const shown = r
    ? `docs ${r.indices.map((i) => i + 1).join(", ") || "(none)"}` +
      (r.invalid.length ? `  [ignored: ${r.invalid.join(", ")}]` : "") +
      (r.capped ? "  [capped]" : "")
    : "not a pick -> falls through to normal search";
  console.log(`  ${JSON.stringify(reply).padEnd(30)} -> ${shown}`);
}
