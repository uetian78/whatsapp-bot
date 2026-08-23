const test = require("node:test");
const assert = require("node:assert");
const { buildButtonsPayload, buildListPayload } = require("../lib/wa.js");

test("buttons: caps at 3, trims titles to 20 chars, dedupes colliding titles", () => {
  const p = buildButtonsPayload("974x", "pick one", [
    { id: "a", title: "Trane Catalogue 2025 Part 1" },
    { id: "b", title: "Trane Catalogue 2025 Part 2" },
    { id: "c", title: "Short" },
    { id: "d", title: "dropped (4th)" },
  ]);
  const btns = p.interactive.action.buttons;
  assert.equal(btns.length, 3);
  for (const b of btns) assert.ok(b.reply.title.length <= 20);
  const titles = btns.map((b) => b.reply.title);
  assert.equal(new Set(titles).size, titles.length, "titles must be unique after trimming");
});

test("list: caps at 10 rows, trims title/description to API limits", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: `fileid|${i}`,
    title: "A very long product datasheet name indeed " + i,
    description: "x".repeat(100),
  }));
  const p = buildListPayload("974x", "body", "Choose a document", rows);
  const out = p.interactive.action.sections[0].rows;
  assert.equal(out.length, 10);
  for (const r of out) {
    assert.ok(r.title.length <= 24);
    assert.ok(r.description.length <= 72);
  }
  assert.ok(p.interactive.action.button.length <= 20);
  assert.equal(p.interactive.type, "list");
});

const { shortPath, displayName } = require("../lib/drive-index.js");

test("shortPath shows the last two folders", () => {
  assert.equal(shortPath("Datasheets/APMR-A Selections"), "Datasheets/APMR-A Selections");
  assert.equal(shortPath("Submittal Files"), "Submittal Files");
  assert.equal(
    shortPath("Submittal Files/14 - Previous Project Approvals/SKM FCUs - Previous Approvals"),
    "14 - Previous Project Approvals/SKM FCUs - Previous Approvals"
  );
});

// Over the limit, fall back to the last folder alone, truncated.
test("shortPath falls back to the last folder when two would overflow", () => {
  const deep = "Submittal Files/10 - Test Certificates/SKM AHRI Coil Certificates - MAH, APMR, APMRA, DMP,DYP, FCU";
  const out = shortPath(deep);
  assert.equal(out, "SKM AHRI Coil Certificates - MAH, APMR, APMRA, DMP,DYP, FCU");
  assert.ok(out.length <= 72);
  assert.ok(!out.includes("/"), "only the last folder survives");

  // A single folder name longer than the limit is hard-truncated.
  const huge = "x".repeat(200);
  assert.equal(shortPath(`Parent/${huge}`).length, 72);
  assert.equal(shortPath(huge, 10), "xxxxxxxxxx");
});

test("shortPath handles empty and missing paths", () => {
  assert.equal(shortPath(""), "");
  assert.equal(shortPath(null), "");
  assert.equal(shortPath(undefined), "");
  assert.equal(shortPath("///"), "");
});

// The whole point of the change: a row's description says where the file
// lives, and the payload builder keeps it inside WhatsApp's limits.
test("list rows carry the folder path as description, within API limits", () => {
  const files = [
    { id: "1", name: "FCU Coil Connection Sheet.xlsx", folder: "Submittal Files" },
    { id: "2", name: "SKM AHRI Coil Certificates (1).pdf", folder: "Submittal Files/10 - Test Certificates/SKM AHRI Coil Certificates - MAH, APMR, APMRA, DMP,DYP, FCU" },
  ];
  const p = buildListPayload("974x", "matches", "Choose a document",
    files.map((f) => ({
      id: `fileid|${f.id}`,
      title: displayName(f).slice(0, 24),
      description: shortPath(f.folder),
    })));

  const rows = p.interactive.action.sections[0].rows;
  assert.equal(rows[0].description, "Submittal Files");
  assert.equal(rows[1].description, "SKM AHRI Coil Certificates - MAH, APMR, APMRA, DMP,DYP, FCU");
  for (const r of rows) {
    assert.ok(r.title.length <= 24, "title within WhatsApp limit");
    assert.ok(r.description.length <= 72, "description within WhatsApp limit");
  }
  // Extension is stripped before truncation, so no characters are wasted.
  assert.ok(!rows[0].title.includes(".xlsx"));
});
