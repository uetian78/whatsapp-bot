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
