const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const PDFDocument = require("pdfkit");
const { extractPages, readFileInWorker, makeReadFile } = require("../lib/pdf-text.js");
const { createPageIndex, openSearchDb, createUploadHandler } = require("../lib/page-index.js");

const MB = 1024 * 1024;
const PDF = "application/pdf";

// A real PDF, one page per string. An empty string makes a blank page.
function makePdf(pageTexts) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    for (const t of pageTexts) {
      doc.addPage();
      if (t) doc.text(t);
    }
    doc.end();
  });
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "page-index-test-"));
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

const file = (id, extra = {}) => ({
  id, name: `${id}.pdf`, folder: "Catalogues", mimeType: PDF, size: 1000, md5: `md5-${id}`, ...extra,
});

// readFile that never forks: pages come from a map keyed by file id.
function fakeRead(pagesById, calls = []) {
  return async (f) => {
    calls.push(f.id);
    const v = pagesById[f.id];
    if (v instanceof Error) throw v;
    if (!v) throw new Error("no such fixture");
    return v;
  };
}

const LONG = "this page has plenty of readable words on it";

async function drain(index) {
  while (await index.runNext());
}

test("extractPages returns one string per page", async () => {
  const buf = await makePdf(["first page about chillers", "the compressor is on page two"]);
  const pages = await extractPages(new Uint8Array(buf));
  assert.equal(pages.length, 2);
  assert.match(pages[0], /chillers/);
  assert.match(pages[1], /compressor/);
});

test("finds text on the right page", async () => {
  const buf = await makePdf(["first page about chillers and nothing else", "the compressor is mounted on page two"]);
  const dir = tmpDir();
  try {
    const index = createPageIndex({
      db: openSearchDb(":memory:"),
      maxBytes: 10 * MB,
      readFile: (f) => readFileInWorker(f, { download: async (_f, dest) => fs.writeFileSync(dest, buf), tmpDir: dir }),
    });
    index.sync([file("a")]);
    await drain(index);
    const hits = index.search("compressor");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].page, 2);
    assert.equal(hits[0].fileId, "a");
    assert.equal(hits[0].name, "a.pdf");
    assert.equal(hits[0].folder, "Catalogues");
    assert.equal(hits[0].size, 1000);
    assert.match(hits[0].snippet, /compressor/);
    assert.deepEqual(fs.readdirSync(dir), [], "the temp copy of the PDF is removed");
  } finally { rm(dir); }
});

test("a PDF with no text is marked noText, not failed", async () => {
  const buf = await makePdf(["", "ab", ""]);
  const index = createPageIndex({
    db: openSearchDb(":memory:"), maxBytes: 10 * MB,
    readFile: async () => extractPages(new Uint8Array(buf)),
  });
  index.sync([file("scan")]);
  await drain(index);
  const s = index.status();
  assert.equal(s.noText, 1);
  assert.equal(s.failed, 0);
  assert.equal(s.indexed, 0);
  assert.equal(s.total, 1);
  assert.deepEqual(index.search("scan"), [], "pages are not searchable, the file name is left to the existing searches");
});

test("a page under 20 characters counts as empty and is not searchable", async () => {
  const index = createPageIndex({
    db: openSearchDb(":memory:"), maxBytes: 10 * MB,
    readFile: fakeRead({ a: [LONG, "tiny words", `${LONG} compressor`] }),
  });
  index.sync([file("a")]);
  await drain(index);
  const s = index.status();
  assert.equal(s.indexed, 1);
  assert.equal(s.pages, 3);
  assert.equal(s.emptyPages, 1);
  assert.equal(index.search("tiny").length, 0);
});

test("a changed md5 replaces the old pages; a removed file's pages disappear", async () => {
  const pages = { a: [`${LONG} alpha`], b: [`${LONG} bravo`] };
  const calls = [];
  const index = createPageIndex({ db: openSearchDb(":memory:"), maxBytes: 10 * MB, readFile: fakeRead(pages, calls) });
  index.sync([file("a"), file("b")]);
  await drain(index);
  assert.equal(index.search("alpha").length, 1);
  assert.equal(index.search("bravo").length, 1);

  // Unchanged files are not read again.
  calls.length = 0;
  index.sync([file("a"), file("b")]);
  assert.equal(await index.runNext(), false);
  assert.deepEqual(calls, []);

  // a changes, b disappears
  pages.a = [`${LONG} charlie`];
  index.sync([file("a", { md5: "md5-a-v2" })]);
  await drain(index);
  assert.deepEqual(calls, ["a"]);
  assert.equal(index.search("alpha").length, 0);
  assert.equal(index.search("charlie").length, 1);
  assert.equal(index.search("bravo").length, 0);
  assert.equal(index.status().total, 1);
});

test("prune: false keeps files that are not in the list", async () => {
  const index = createPageIndex({
    db: openSearchDb(":memory:"), maxBytes: 10 * MB,
    readFile: fakeRead({ a: [`${LONG} alpha`], b: [`${LONG} bravo`] }),
  });
  index.sync([file("a"), file("b")]);
  await drain(index);
  index.sync([file("a")], { prune: false });
  assert.equal(index.search("bravo").length, 1);
});

test("a renamed file shows its new name without being read again", async () => {
  const calls = [];
  const index = createPageIndex({ db: openSearchDb(":memory:"), maxBytes: 10 * MB, readFile: fakeRead({ a: [`${LONG} alpha`] }, calls) });
  index.sync([file("a")]);
  await drain(index);
  index.sync([file("a", { name: "Renamed.pdf", folder: "IOM" })]);
  assert.equal(await index.runNext(), false);
  assert.equal(calls.length, 1);
  const [hit] = index.search("alpha");
  assert.equal(hit.name, "Renamed.pdf");
  assert.equal(hit.folder, "IOM");
});

test("files that are not PDFs are skipped", async () => {
  const calls = [];
  const index = createPageIndex({ db: openSearchDb(":memory:"), maxBytes: 10 * MB, readFile: fakeRead({}, calls) });
  index.sync([
    file("x", { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: "x.xlsx" }),
    file("g", { mimeType: "application/vnd.google-apps.document", name: "g.docx", exportMime: "application/x" }),
  ]);
  assert.equal(await index.runNext(), false);
  assert.equal(index.status().total, 0);
  assert.deepEqual(calls, []);
});

test("a file over maxBytes is marked tooLarge and never read", async () => {
  const calls = [];
  const index = createPageIndex({
    db: openSearchDb(":memory:"), maxBytes: 5000, readFile: fakeRead({ big: [LONG], small: [`${LONG} small`] }, calls),
  });
  index.sync([file("big", { size: 6000 }), file("small", { size: 100 })]);
  await drain(index);
  assert.deepEqual(calls, ["small"]);
  const s = index.status();
  assert.equal(s.tooLarge, 1);
  assert.equal(s.indexed, 1);
});

test("a tooLarge file is read once the limit allows it", async () => {
  const dir = tmpDir();
  try {
    const dbFile = path.join(dir, "search.db");
    const small = createPageIndex({ path: dbFile, maxBytes: 5000, readFile: fakeRead({ big: [`${LONG} bigword`] }) });
    small.sync([file("big", { size: 6000 })]);
    await drain(small);
    assert.equal(small.status().tooLarge, 1);
    small.close();
    const pc = createPageIndex({ path: dbFile, maxBytes: Infinity, readFile: fakeRead({ big: [`${LONG} bigword`] }) });
    pc.sync([file("big", { size: 6000 })]);
    await drain(pc);
    assert.equal(pc.status().tooLarge, 0);
    assert.equal(pc.search("bigword").length, 1);
    pc.close();
  } finally { rm(dir); }
});

test("a file that fails to read is marked failed and the next file still runs", async () => {
  const index = createPageIndex({
    db: openSearchDb(":memory:"), maxBytes: 10 * MB,
    readFile: fakeRead({ bad: new Error("Invalid PDF structure"), good: [`${LONG} goodword`] }),
  });
  index.sync([file("bad"), file("good")]);
  await drain(index);
  const s = index.status();
  assert.equal(s.failed, 1);
  assert.equal(s.indexed, 1);
  assert.equal(index.search("goodword").length, 1);
});

test("failed files are tried again only when asked", async () => {
  const pages = { bad: new Error("boom") };
  const index = createPageIndex({ db: openSearchDb(":memory:"), maxBytes: 10 * MB, readFile: fakeRead(pages) });
  index.sync([file("bad")]);
  await drain(index);
  index.sync([file("bad")]);
  assert.equal(await index.runNext(), false);
  pages.bad = [`${LONG} fixedword`];
  index.sync([file("bad")], { retryFailed: true });
  await drain(index);
  assert.equal(index.search("fixedword").length, 1);
});

// ── real child processes ────────────────────────────────────────────────

function writeWorker(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

test("a worker crash marks that file failed and the next file still runs", async () => {
  const dir = tmpDir();
  try {
    const good = await makePdf(["intro page with enough words in it", "second page mentions the evaporator"]);
    const crash = writeWorker(dir, "crash.js", "process.on('message', () => process.exit(3));");
    const index = createPageIndex({
      db: openSearchDb(":memory:"), maxBytes: 10 * MB,
      readFile: (f) => readFileInWorker(f, {
        download: async (_f, dest) => fs.writeFileSync(dest, good),
        workerPath: f.id === "crash" ? crash : undefined,
        tmpDir: dir,
      }),
    });
    index.sync([file("crash"), file("ok")]);
    await drain(index);
    const s = index.status();
    assert.equal(s.failed, 1);
    assert.equal(s.indexed, 1);
    assert.equal(index.search("evaporator")[0].fileId, "ok");
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".pdf")), [], "temp PDFs are removed");
  } finally { rm(dir); }
});

test("a worker that runs too long is killed, and a bad message fails the file", async () => {
  const dir = tmpDir();
  try {
    const hang = writeWorker(dir, "hang.js", "process.on('message', () => setInterval(() => {}, 1000));");
    const odd = writeWorker(dir, "odd.js", "process.on('message', () => process.send({ surprise: true }));");
    const dl = async (_f, dest) => fs.writeFileSync(dest, "x");
    const started = Date.now();
    await assert.rejects(readFileInWorker(file("h"), { download: dl, workerPath: hang, timeoutMs: 300, tmpDir: dir }), /took too long/);
    assert.ok(Date.now() - started < 5000);
    await assert.rejects(readFileInWorker(file("o"), { download: dl, workerPath: odd, tmpDir: dir }), /unexpected message/);
  } finally { rm(dir); }
});

test("the worker reads a damaged PDF as a failure, not a crash of the parent", async () => {
  const dir = tmpDir();
  try {
    await assert.rejects(readFileInWorker(file("junk"), {
      download: async (_f, dest) => fs.writeFileSync(dest, "this is not a pdf at all"), tmpDir: dir,
    }));
  } finally { rm(dir); }
});

test("a download larger than the limit is tooLarge without being kept", async () => {
  const dir = tmpDir();
  try {
    const index = createPageIndex({
      db: openSearchDb(":memory:"), maxBytes: 10 * MB,
      readFile: (f) => readFileInWorker(f, {
        download: async () => { throw Object.assign(new Error("too big"), { code: "TOO_LARGE" }); }, tmpDir: dir,
      }),
    });
    index.sync([file("nosize", { size: undefined })]);
    await drain(index);
    assert.equal(index.status().tooLarge, 1);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { rm(dir); }
});

test("indexing resumes after a restart where it stopped", async () => {
  const dir = tmpDir();
  try {
    const dbFile = path.join(dir, "search.db");
    const pages = { a: [`${LONG} alpha`], b: [`${LONG} bravo`], c: [`${LONG} charlie`] };
    const first = createPageIndex({ path: dbFile, maxBytes: 10 * MB, readFile: fakeRead(pages) });
    first.sync([file("a"), file("b"), file("c")]);
    assert.equal(await first.runNext(), true); // only one file done
    first.close();

    const calls = [];
    const second = createPageIndex({ path: dbFile, maxBytes: 10 * MB, readFile: fakeRead(pages, calls) });
    await drain(second); // no sync needed: the queue was saved
    assert.deepEqual(calls, ["b", "c"]);
    assert.equal(second.status().indexed, 3);
    second.close();
  } finally { rm(dir); }
});

test("drain works through the queue once, even when called twice", async () => {
  const calls = [];
  const index = createPageIndex({
    db: openSearchDb(":memory:"), maxBytes: 10 * MB,
    readFile: fakeRead({ a: [`${LONG} alpha`], b: [`${LONG} bravo`] }, calls),
  });
  index.sync([file("a"), file("b")]);
  await Promise.all([index.drain(), index.drain()]);
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(index.status().indexed, 2);
});

// ── search ──────────────────────────────────────────────────────────────

test("odd search text returns results or [] and never throws", async () => {
  const index = createPageIndex({ db: openSearchDb(":memory:"), maxBytes: 10 * MB, readFile: fakeRead({ a: [`${LONG} apmr t3`] }) });
  index.sync([file("a")]);
  await drain(index);
  for (const q of ['"', "*", "APMR-A (T3)", "AND", "NEAR(", "-", "'; DROP", "", "   ", "a", "OR NOT", "col:val", "^x"]) {
    assert.ok(Array.isArray(index.search(q)), q);
  }
  assert.equal(index.search("APMR-A (T3)").length, 1);
});

test("every word is tried first, then any word", async () => {
  const index = createPageIndex({
    db: openSearchDb(":memory:"), maxBytes: 10 * MB,
    readFile: fakeRead({ a: [`${LONG} evaporator pressure`], b: [`${LONG} evaporator`] }),
  });
  index.sync([file("a"), file("b")]);
  await drain(index);
  const both = index.search("evaporator pressure");
  assert.deepEqual(both.map((h) => h.fileId), ["a"]);
  const any = index.search("evaporator zzzunknown");
  assert.deepEqual(any.map((h) => h.fileId).sort(), ["a", "b"]);
});

test("a match in the file name ranks above the same word in the body", async () => {
  const index = createPageIndex({
    db: openSearchDb(":memory:"), maxBytes: 10 * MB,
    readFile: fakeRead({ body: [`${LONG} scroll`], named: [`${LONG} something else`] }),
  });
  index.sync([file("body", { name: "Other.pdf" }), file("named", { name: "Scroll.pdf" })]);
  await drain(index);
  assert.equal(index.search("scroll")[0].fileId, "named");
});

test("a file named with the query word cannot fill the results with its own pages", async () => {
  const named = Array.from({ length: 20 }, (_, i) => `${LONG} chapter ${i} of the manual`);
  const index = createPageIndex({
    db: openSearchDb(":memory:"), maxBytes: 10 * MB,
    readFile: fakeRead({ named, body: [`${LONG} the scroll compressor`] }),
  });
  index.sync([file("named", { name: "Scroll.pdf" }), file("body", { name: "Other.pdf" })]);
  await drain(index);
  const hits = index.search("scroll");
  const ids = hits.map((h) => h.fileId);
  assert.ok(ids.includes("named") && ids.includes("body"), `both files appear: ${ids.join(",")}`);
  assert.equal(ids.filter((id) => id === "named").length, 2, "default is 2 hits per file");
  assert.equal(index.search("scroll", { perFile: 3 }).filter((h) => h.fileId === "named").length, 3);
  assert.equal(index.search("scroll", { perFile: 1 }).length, 2);
  // the named file's pages rank first
  assert.equal(hits[0].fileId, "named");
});

test("textChars adds the page text, cut to that length", async () => {
  const body = `${"alpha ".repeat(50)}beta`;
  const index = createPageIndex({ db: openSearchDb(":memory:"), maxBytes: 10 * MB, readFile: fakeRead({ a: [body] }) });
  index.sync([file("a")]);
  await drain(index);
  assert.equal(index.search("alpha")[0].text, undefined);
  const hit = index.search("alpha", { textChars: 40 })[0];
  assert.equal(hit.text.length, 40);
  assert.equal(hit.text, body.slice(0, 40));
  assert.equal(hit.page, 1);
});

test("anyWord: false keeps the every-word search and does not fall back to any word", async () => {
  const index = createPageIndex({
    db: openSearchDb(":memory:"), maxBytes: 10 * MB,
    readFile: fakeRead({ a: [`${LONG} evaporator`] }),
  });
  index.sync([file("a")]);
  await drain(index);
  assert.equal(index.search("evaporator zzzunknown").length, 1);
  assert.deepEqual(index.search("evaporator zzzunknown", { anyWord: false }), []);
});

test("limit caps the number of hits", async () => {
  const many = {};
  const files = [];
  for (let i = 0; i < 12; i++) { many[`f${i}`] = [`${LONG} refrigerant`]; files.push(file(`f${i}`)); }
  const index = createPageIndex({ db: openSearchDb(":memory:"), maxBytes: 10 * MB, readFile: fakeRead(many) });
  index.sync(files);
  await drain(index);
  assert.equal(index.search("refrigerant").length, 8);
  assert.equal(index.search("refrigerant", { limit: 3 }).length, 3);
});

test("docType limits results by folder", async () => {
  const index = createPageIndex({
    db: openSearchDb(":memory:"), maxBytes: 10 * MB,
    readFile: fakeRead({ c: [`${LONG} fan`], i: [`${LONG} fan`], s: [`${LONG} fan`], n: [`${LONG} fan`] }),
  });
  index.sync([
    file("c", { folder: "Catalogues/Hisense VRF" }),
    file("i", { folder: "IOMs" }),
    file("s", { folder: "Submittal Files/Catalogue Pages" }),
    file("n", { folder: "Misc" }),
  ]);
  await drain(index);
  assert.deepEqual(index.search("fan", { docType: "Catalogue" }).map((h) => h.fileId), ["c"]);
  assert.deepEqual(index.search("fan", { docType: "IOM" }).map((h) => h.fileId), ["i"]);
  assert.equal(index.search("fan").length, 4);
  assert.deepEqual(index.search("fan", { docType: "Whatever" }), []);
});

test("with no index file yet, search is [] and status is zeros, and nothing is created", async () => {
  const dir = tmpDir();
  try {
    const dbFile = path.join(dir, "sub", "search.db");
    const index = createPageIndex({ path: dbFile, maxBytes: 10 * MB, readFile: fakeRead({}) });
    assert.deepEqual(index.search("anything"), []);
    assert.deepEqual(index.status(), { total: 0, indexed: 0, noText: 0, tooLarge: 0, failed: 0, pages: 0, emptyPages: 0 });
    assert.equal(await index.runNext(), false);
    index.sync([]);
    assert.equal(index.exists(), false);
    assert.equal(fs.existsSync(path.join(dir, "sub")), false);
  } finally { rm(dir); }
});

// ── replacing the index file ────────────────────────────────────────────

async function buildIndexFile(file1, pagesById, files) {
  const idx = createPageIndex({ path: file1, maxBytes: Infinity, readFile: fakeRead(pagesById) });
  idx.sync(files);
  await drain(idx);
  idx.close();
}

test("an uploaded search.db replaces the old one and search keeps working", async () => {
  const dir = tmpDir();
  try {
    const live = path.join(dir, "data", "search.db");
    const incoming = path.join(dir, "incoming.db");
    await buildIndexFile(live, { a: [`${LONG} oldword`] }, [file("a")]);
    await buildIndexFile(incoming, { z: [`${LONG} newword`] }, [file("z")]);

    const index = createPageIndex({ path: live, maxBytes: 10 * MB, readFile: fakeRead({}) });
    assert.equal(index.search("oldword").length, 1);
    await index.replaceDb(incoming);
    assert.equal(index.search("oldword").length, 0);
    assert.equal(index.search("newword")[0].fileId, "z");
    assert.equal(index.status().total, 1);
    assert.deepEqual(fs.readdirSync(path.dirname(live)).sort(), ["search.db"], "no leftovers beside the live file");
    index.close();
  } finally { rm(dir); }
});

test("a bad upload leaves the old search.db in place", async () => {
  const dir = tmpDir();
  try {
    const live = path.join(dir, "search.db");
    await buildIndexFile(live, { a: [`${LONG} oldword`] }, [file("a")]);
    const index = createPageIndex({ path: live, maxBytes: 10 * MB, readFile: fakeRead({}) });
    assert.equal(index.search("oldword").length, 1);

    const garbage = path.join(dir, "garbage.db");
    fs.writeFileSync(garbage, "definitely not sqlite");
    await assert.rejects(index.replaceDb(garbage), (e) => e.code === "BAD_INDEX");

    const wrong = path.join(dir, "wrong.db");
    const { DatabaseSync } = require("node:sqlite");
    const w = new DatabaseSync(wrong);
    w.exec("CREATE TABLE other (x)");
    w.close();
    await assert.rejects(index.replaceDb(wrong), (e) => e.code === "BAD_INDEX");

    const empty = path.join(dir, "empty.db");
    fs.writeFileSync(empty, "");
    await assert.rejects(index.replaceDb(empty), (e) => e.code === "BAD_INDEX");

    assert.equal(index.search("oldword").length, 1, "old index still answers");
    index.close();
    // and still opens from disk
    const again = createPageIndex({ path: live, maxBytes: 10 * MB, readFile: fakeRead({}) });
    assert.equal(again.search("oldword").length, 1);
    again.close();
  } finally { rm(dir); }
});

test("when the new file can only be copied and there is no room, the old index is kept and the error says so", async () => {
  const dir = tmpDir();
  try {
    const live = path.join(dir, "search.db");
    const incoming = path.join(dir, "incoming.db");
    await buildIndexFile(live, { a: [`${LONG} oldword`] }, [file("a")]);
    await buildIndexFile(incoming, { z: [`${LONG} newword`] }, [file("z")]);
    const index = createPageIndex({
      path: live, maxBytes: 10 * MB, readFile: fakeRead({}),
      fsOps: {
        rename: () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); },
        freeBytes: () => 10, // nowhere near enough
      },
    });
    await assert.rejects(index.replaceDb(incoming), (e) => e.code === "NO_ROOM" && /old search index is still in use/.test(e.message));
    assert.equal(index.search("oldword").length, 1);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["incoming.db", "search.db"]);
    index.close();
  } finally { rm(dir); }
});

test("a copy that fails midway leaves the old index usable and no partial file", async () => {
  const dir = tmpDir();
  try {
    const live = path.join(dir, "search.db");
    const incoming = path.join(dir, "incoming.db");
    await buildIndexFile(live, { a: [`${LONG} oldword`] }, [file("a")]);
    await buildIndexFile(incoming, { z: [`${LONG} newword`] }, [file("z")]);
    const index = createPageIndex({
      path: live, maxBytes: 10 * MB, readFile: fakeRead({}),
      fsOps: {
        rename: (a, b) => { if (b === live) return fs.renameSync(a, b); throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); },
        freeBytes: () => 1e12,
        copy: async (_from, to) => { fs.writeFileSync(to, "partial"); throw new Error("disk full"); },
      },
    });
    await assert.rejects(index.replaceDb(incoming), /disk full|old search index is still in use/);
    assert.equal(index.search("oldword").length, 1);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["incoming.db", "search.db"]);
    index.close();
  } finally { rm(dir); }
});

test("a cross-device upload is copied beside the live file, then swapped in", async () => {
  const dir = tmpDir();
  try {
    const live = path.join(dir, "search.db");
    const incoming = path.join(dir, "incoming.db");
    await buildIndexFile(live, { a: [`${LONG} oldword`] }, [file("a")]);
    await buildIndexFile(incoming, { z: [`${LONG} newword`] }, [file("z")]);
    const index = createPageIndex({
      path: live, maxBytes: 10 * MB, readFile: fakeRead({}),
      fsOps: {
        rename: (a, b) => {
          if (a === incoming) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
          return fs.renameSync(a, b);
        },
      },
    });
    await index.replaceDb(incoming);
    assert.equal(index.search("newword").length, 1);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["incoming.db", "search.db"], "the source is left for the caller to remove");
    index.close();
  } finally { rm(dir); }
});

// ── the upload endpoint ─────────────────────────────────────────────────

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function post(server, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: server.address().port, path: "/admin/search-index", method: "POST", headers: { "Content-Type": "application/octet-stream", ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function uploadSetup({ maxBytes = 50 * MB } = {}) {
  const dir = tmpDir();
  const tmp = path.join(dir, "tmp");
  fs.mkdirSync(tmp);
  const live = path.join(dir, "data", "search.db");
  await buildIndexFile(live, { a: [`${LONG} oldword`] }, [file("a")]);
  const incoming = path.join(dir, "incoming.db");
  await buildIndexFile(incoming, { z: [`${LONG} newword`] }, [file("z")]);
  const index = createPageIndex({ path: live, maxBytes: 10 * MB, readFile: fakeRead({}) });
  const app = express();
  app.use(express.json());
  app.post("/admin/search-index", createUploadHandler({ index, maxBytes, tmpDir: tmp }));
  const server = await listen(app);
  return {
    dir, tmp, live, incoming, index, server,
    done: () => { server.close(); index.close(); rm(dir); },
  };
}

test("POST search-index swaps the uploaded file in and answers with the status", async () => {
  const t = await uploadSetup();
  try {
    const res = await post(t.server, fs.readFileSync(t.incoming));
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.total, 1);
    assert.equal(json.indexed, 1);
    assert.doesNotMatch(res.body, /newword/, "no document text in the reply");
    assert.equal(t.index.search("newword").length, 1);
    assert.deepEqual(fs.readdirSync(t.tmp), [], "the upload temp file is removed");
  } finally { t.done(); }
});

test("POST search-index with a bad file answers 400 and keeps the old index", async () => {
  const t = await uploadSetup();
  try {
    const res = await post(t.server, Buffer.from("not a database"));
    assert.equal(res.status, 400);
    assert.equal(t.index.search("oldword").length, 1);
    assert.deepEqual(fs.readdirSync(t.tmp), []);
  } finally { t.done(); }
});

test("POST search-index over the size limit answers 413 and keeps nothing", async () => {
  const t = await uploadSetup({ maxBytes: 100 });
  try {
    const res = await post(t.server, fs.readFileSync(t.incoming));
    assert.equal(res.status, 413);
    assert.equal(t.index.search("oldword").length, 1);
    assert.deepEqual(fs.readdirSync(t.tmp), []);
  } finally { t.done(); }
});

test("POST search-index over the limit without a Content-Length is stopped while streaming", async () => {
  const t = await uploadSetup({ maxBytes: 100 });
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: t.server.address().port, path: "/admin/search-index", method: "POST", headers: { "Content-Type": "application/octet-stream", "Transfer-Encoding": "chunked" } },
        (r) => { r.resume(); r.on("end", () => resolve({ status: r.statusCode })); }
      );
      req.on("error", reject);
      req.write(Buffer.alloc(60));
      req.write(Buffer.alloc(60));
      req.end(Buffer.alloc(60));
    });
    assert.equal(res.status, 413);
    assert.deepEqual(fs.readdirSync(t.tmp), []);
  } finally { t.done(); }
});

test("the upload handler reads its limit from SEARCH_INDEX_MAX_MB, default 400", () => {
  const { uploadLimitBytes } = require("../lib/page-index.js");
  assert.equal(uploadLimitBytes({}), 400 * MB);
  assert.equal(uploadLimitBytes({ SEARCH_INDEX_MAX_MB: "12" }), 12 * MB);
  assert.equal(uploadLimitBytes({ SEARCH_INDEX_MAX_MB: "nonsense" }), 400 * MB);
});

test("makeReadFile reads sizes and memory from env, with defaults", () => {
  const { pdfLimits } = require("../lib/pdf-text.js");
  assert.deepEqual(pdfLimits({}), { maxBytes: 10 * MB, memoryMb: 256 });
  assert.deepEqual(pdfLimits({ PDF_INDEX_MAX_MB: "3", PDF_WORKER_MEMORY_MB: "512" }), { maxBytes: 3 * MB, memoryMb: 512 });
  assert.equal(typeof makeReadFile({ memoryMb: 256 }), "function");
});

test("requiring the server opens no search.db", () => {
  const dir = tmpDir();
  try {
    const { spawnSync } = require("node:child_process");
    const r = spawnSync(process.execPath, ["-e", "require('./lib/page-index.js').getPageIndex(); require('./lib/page-index.js').getPageIndex().search('x');"], {
      cwd: path.join(__dirname, ".."), env: { ...process.env, DATA_DIR: dir }, encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { rm(dir); }
});

test("compact leaves one self-contained file that still searches, and failures lists ids", async () => {
  const dir = tmpDir();
  try {
    const live = path.join(dir, "search.db");
    const index = createPageIndex({ path: live, maxBytes: Infinity, readFile: fakeRead({ a: [`${LONG} alpha`], bad: new Error("Invalid PDF structure") }) });
    index.sync([file("a"), file("bad")]);
    await drain(index);
    index.compact();
    assert.deepEqual(index.failures(), [{ id: "bad", error: "Invalid PDF structure" }]);
    index.close();
    assert.deepEqual(fs.readdirSync(dir), ["search.db"]);
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(live, { readOnly: true });
    assert.equal(raw.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
    raw.close();
    const again = createPageIndex({ path: live, maxBytes: Infinity, readFile: fakeRead({}) });
    assert.equal(again.search("alpha").length, 1);
    again.close();
  } finally { rm(dir); }
});

// ── an empty list must never wipe the index ─────────────────────────────

test("sync([]) and a list with no PDFs keep every indexed file and say so", async (t) => {
  const dir = tmpDir();
  try {
    const errors = [];
    t.mock.method(console, "error", (...a) => errors.push(a.join(" ")));
    const index = createPageIndex({ path: path.join(dir, "search.db"), maxBytes: 10 * MB, readFile: fakeRead({ a: [`${LONG} keepme`] }) });
    index.sync([file("a")]);
    await drain(index);
    assert.equal(index.search("keepme").length, 1);

    assert.deepEqual(index.sync([]), { queued: 0, removed: 0 });
    assert.deepEqual(index.sync([{ id: "n", name: "notes.txt", mimeType: "text/plain" }]), { queued: 0, removed: 0 });
    assert.equal(index.search("keepme").length, 1);
    assert.equal(index.status().total, 1);
    assert.ok(errors.some((e) => /no PDFs/.test(e)), "the empty list is logged");

    // A real list still prunes what vanished.
    index.sync([file("b")]);
    assert.equal(index.search("keepme").length, 0);
    index.close();
  } finally { rm(dir); }
});
