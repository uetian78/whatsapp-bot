const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { openDb } = require("../lib/db.js");
const { createLibraryIndex } = require("../lib/drive-index.js");

const FOLDER = "root-folder";
const FOLDER_MIME = "application/vnd.google-apps.folder";

const pdf = (id, name, md5, extra = {}) => ({
  id, name, mimeType: "application/pdf", size: "1000", md5Checksum: md5, modifiedTime: "2026-01-01T00:00:00.000Z", ...extra,
});

// A fake Drive client over a mutable tree: { folderId: [items] }. It answers
// the crawl's files.list query, two items to a page so paging is exercised.
function fakeDrive(tree, state) {
  return {
    files: {
      list: async ({ q, pageToken }) => {
        state.listCalls += 1;
        if (state.gate) await state.gate;
        if (state.fail) throw Object.assign(new Error("Drive is down"), { code: 400 });
        const parent = /^'([^']+)' in parents/.exec(q)[1];
        const items = tree[parent] || [];
        const from = Number(pageToken || 0);
        const page = items.slice(from, from + 2);
        const next = from + 2 < items.length ? String(from + 2) : undefined;
        return { data: { files: page, nextPageToken: next } };
      },
    },
  };
}

function setup(tree, opts = {}) {
  const state = { listCalls: 0, driveCalls: 0, gate: null, fail: false };
  const clock = { t: 1_000_000 };
  const db = opts.db || openDb(":memory:");
  const make = (extra = {}) =>
    createLibraryIndex({
      db,
      getDrive: async () => { state.driveCalls += 1; return fakeDrive(tree, state); },
      folderId: FOLDER,
      now: () => clock.t,
      staleMs: 600_000,
      ...extra,
    });
  return { state, clock, db, tree, make, index: make() };
}

function basicTree() {
  return {
    [FOLDER]: [
      pdf("a1", "APMR-A.pdf", "m1"),
      { id: "sub1", name: "Catalogues", mimeType: FOLDER_MIME },
      { id: "x1", name: "notes.txt", mimeType: "text/plain" },
    ],
    sub1: [pdf("b1", "ACMR IOM.pdf", "m2"), pdf("b2", "APCY-H.pdf", "m3")],
  };
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "hvac-lib-")); }

// Resolves when the next refresh finishes (its onRefresh handler fires).
const nextRefresh = (index) => new Promise((resolve) => {
  let done = false;
  index.onRefresh((files, diff) => { if (!done) { done = true; resolve({ files, diff }); } });
});

test("first call crawls and saves; a new instance reads the saved list without crawling", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "lib.db");
  const a = setup(basicTree(), { db: openDb(file) });
  const first = await a.index.list();
  assert.deepEqual(first.map((f) => f.id), ["a1", "b1", "b2"]);
  assert.deepEqual(first[0], {
    id: "a1", name: "APMR-A.pdf", folder: "(root)", mimeType: "application/pdf", size: 1000, md5: "m1",
    modifiedTime: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(first[1].folder, "Catalogues");
  const crawled = a.state.listCalls;
  assert.ok(crawled > 0);
  a.db.close();

  // "Restart": new database handle, new index, nothing crawled.
  const b = setup(basicTree(), { db: openDb(file) });
  assert.equal(b.index.findById("b2").name, "APCY-H.pdf"); // sync, from the DB, no list() first
  assert.deepEqual((await b.index.list()).map((f) => f.id), ["a1", "b1", "b2"]);
  assert.equal(b.state.listCalls, 0);
  assert.equal(b.state.driveCalls, 0);
  b.db.close();
});

test("findById returns null before any list exists, and for unknown ids", async () => {
  const s = setup(basicTree());
  assert.equal(s.index.findById("a1"), null);
  await s.index.list();
  assert.equal(s.index.findById("a1").id, "a1");
  assert.equal(s.index.findById("nope"), null);
  assert.equal(s.index.findById(undefined), null);
});

test("a stale list returns at once and refreshes in the background, one refresh at a time", async () => {
  const s = setup(basicTree());
  await s.index.list();
  const before = s.state.listCalls;

  // Fresh: no new crawl.
  s.clock.t += 599_000;
  await s.index.list();
  assert.equal(s.state.listCalls, before);

  // Stale (older than staleMs): a new file appears, but list() answers from the saved list.
  s.clock.t += 2_000;
  s.tree[FOLDER].push(pdf("a2", "ACMR.pdf", "m4"));
  s.state.gate = new Promise((r) => { s.release = r; });
  const done = nextRefresh(s.index);
  const one = await s.index.list();
  const two = await s.index.list(); // second call during the refresh
  assert.deepEqual(one.map((f) => f.id), ["a1", "b1", "b2"]);
  assert.deepEqual(two.map((f) => f.id), ["a1", "b1", "b2"]);
  assert.equal(s.state.driveCalls, 2); // the first crawl + exactly one refresh
  s.release();
  const { diff } = await done;
  assert.deepEqual(diff.added.map((f) => f.id), ["a2"]);
  assert.deepEqual((await s.index.list()).map((f) => f.id), ["a1", "a2", "b1", "b2"]);
  assert.equal(s.state.driveCalls, 2);
});

test("a first-ever list with nothing saved awaits the crawl, and concurrent callers share it", async () => {
  const s = setup(basicTree());
  const [x, y] = await Promise.all([s.index.list(), s.index.list()]);
  assert.equal(x.length, 3);
  assert.equal(y.length, 3);
  assert.equal(s.state.driveCalls, 1);
});

test("a failed refresh keeps the old list", async () => {
  const s = setup(basicTree());
  await s.index.list();
  s.state.fail = true;
  await assert.rejects(() => s.index.refresh(), /Drive is down/);
  assert.equal(s.index.findById("a1").id, "a1");
  assert.deepEqual((await s.index.list()).map((f) => f.id), ["a1", "b1", "b2"]);

  // A crawl that dies halfway (root pages fine, subfolder fails) saves nothing.
  s.state.fail = false;
  s.tree[FOLDER].push(pdf("a9", "NEW.pdf", "m9"));
  const realList = fakeDrive(s.tree, s.state).files.list;
  const flaky = createLibraryIndex({
    db: s.db,
    getDrive: async () => ({ files: { list: async (args) => {
      if (args.q.startsWith("'sub1'")) throw new Error("half way");
      return realList(args);
    } } }),
    folderId: FOLDER,
    now: () => s.clock.t,
  });
  await assert.rejects(() => flaky.refresh(), /half way/);
  assert.equal(flaky.findById("a9"), null);
  assert.equal(flaky.findById("b1").id, "b1");
});

test("a failed background refresh is logged, not thrown, and the old list is served", async (t) => {
  const s = setup(basicTree());
  await s.index.list();
  const errors = [];
  t.mock.method(console, "error", (...a) => errors.push(a.join(" ")));
  s.state.fail = true;
  s.clock.t += 700_000;
  const list = await s.index.list();
  assert.equal(list.length, 3);
  // The crawl retries a few times before giving up.
  for (let i = 0; i < 100 && !errors.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(errors.some((e) => /Drive is down/.test(e)), errors.join("|"));
});

test("an empty crawl over a saved list is treated as a failure and keeps the list", async (t) => {
  const s = setup(basicTree());
  await s.index.list();
  const errors = [];
  t.mock.method(console, "error", (...a) => errors.push(a.join(" ")));
  s.tree[FOLDER] = [];
  await assert.rejects(() => s.index.refresh(), /empty/i);
  assert.equal(s.index.findById("a1").id, "a1");
  assert.equal((await s.index.list()).length, 3);
  assert.ok(errors.some((e) => /empty/i.test(e)), "the empty crawl is logged");
});

test("an empty crawl with nothing saved saves an empty list", async () => {
  const s = setup({ [FOLDER]: [] });
  assert.deepEqual(await s.index.list(), []);
  assert.equal(s.state.driveCalls, 1);
  await s.index.list();
  assert.equal(s.state.driveCalls, 1); // saved, so not crawled again while fresh
});

test("refresh reports added, changed by md5, and removed", async () => {
  const s = setup(basicTree());
  const first = await s.index.refresh();
  assert.deepEqual(first.added.map((f) => f.id), ["a1", "b1", "b2"]);
  assert.deepEqual(first.changed, []);
  assert.deepEqual(first.removed, []);

  s.tree.sub1 = [pdf("b1", "ACMR IOM.pdf", "m2-NEW"), pdf("b3", "ACMR.pdf", "m5")]; // b1 changed, b2 gone, b3 new
  const diff = await s.index.refresh();
  assert.deepEqual(diff.added.map((f) => f.id), ["b3"]);
  assert.deepEqual(diff.changed.map((f) => f.id), ["b1"]);
  assert.deepEqual(diff.removed.map((f) => f.id), ["b2"]);
  assert.equal(s.index.findById("b1").md5, "m2-NEW");
  assert.equal(s.index.findById("b2"), null);

  const same = await s.index.refresh();
  assert.deepEqual([same.added.length, same.changed.length, same.removed.length], [0, 0, 0]);
});

test("changes fall back to modifiedTime when md5 is missing", async () => {
  const gdoc = (modified) => ({
    id: "g1", name: "FCU Coil Sheet", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: modified,
  });
  const s = setup({ [FOLDER]: [gdoc("2026-01-01T00:00:00.000Z"), pdf("a1", "APMR-A.pdf", "m1")] });
  await s.index.refresh();
  assert.equal(s.index.findById("g1").md5, undefined);
  const none = await s.index.refresh();
  assert.deepEqual(none.changed, []);
  s.tree[FOLDER][0] = gdoc("2026-02-02T00:00:00.000Z");
  const diff = await s.index.refresh();
  assert.deepEqual(diff.changed.map((f) => f.id), ["g1"]);
});

test("Google Docs keep their export extension and exportMime", async () => {
  const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const dir = tmpDir();
  const file = path.join(dir, "g.db");
  const s = setup({
    [FOLDER]: [{ id: "g1", name: "FCU Coil Connection Sheet", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-03-03T00:00:00.000Z" }],
  }, { db: openDb(file) });
  const [rec] = await s.index.list();
  assert.equal(rec.name, "FCU Coil Connection Sheet.xlsx");
  assert.equal(rec.exportMime, XLSX);
  assert.equal(rec.mimeType, "application/vnd.google-apps.spreadsheet");
  s.db.close();
  const again = setup({}, { db: openDb(file) });
  const saved = again.index.findById("g1");
  assert.equal(saved.name, "FCU Coil Connection Sheet.xlsx");
  assert.equal(saved.exportMime, XLSX);
  assert.equal(saved.md5, undefined);
  again.db.close();
});

test("refresh logs a count, not every file name", async (t) => {
  const lines = [];
  for (const m of ["log", "info", "warn", "error"]) t.mock.method(console, m, (...a) => lines.push(a.join(" ")));
  const s = setup(basicTree());
  await s.index.refresh();
  const out = lines.join("\n");
  assert.match(out, /\b3 files\b/);
  for (const name of ["APMR-A", "ACMR IOM", "APCY-H", "notes.txt"]) assert.ok(!out.includes(name), `logged ${name}`);
});

test("onRefresh handlers get the list and the diff; a throwing handler doesn't fail the refresh", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...a) => errors.push(a.join(" ")));
  const s = setup(basicTree());
  const seen = [];
  s.index.onRefresh(() => { throw new Error("handler boom"); });
  s.index.onRefresh(async () => { throw new Error("async boom"); });
  s.index.onRefresh((files, diff) => seen.push({ files, diff }));
  const diff = await s.index.refresh();
  assert.equal(diff.added.length, 3);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].files.length, 3);
  assert.deepEqual(seen[0].diff.added.map((f) => f.id), ["a1", "b1", "b2"]);
  await new Promise((r) => setImmediate(r));
  assert.ok(errors.some((e) => /handler boom/.test(e)));
  assert.ok(errors.some((e) => /async boom/.test(e)));
});

test("no refresh runs unless someone asks for the list", async (t) => {
  const timers = [];
  t.mock.method(global, "setInterval", (...a) => { timers.push(a); return { unref() {} }; });
  const s = setup(basicTree());
  await s.index.list();
  const calls = s.state.driveCalls;
  s.clock.t += 24 * 3600_000;
  await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setImmediate(r));
  assert.equal(s.state.driveCalls, calls);
  assert.equal(timers.length, 0);
  assert.equal(s.index.findById("a1").id, "a1"); // findById never crawls either
  assert.equal(s.state.driveCalls, calls);
});

test("requiring drive-index opens no database, and listFolderFiles without a folder id is empty", () => {
  const dir = tmpDir();
  const code = `
    const d = require(${JSON.stringify(path.join(__dirname, "..", "lib", "drive-index.js"))});
    d.listFolderFiles().then((r) => { console.log(JSON.stringify(r)); });
  `;
  const env = { ...process.env, DATA_DIR: path.join(dir, "data") };
  delete env.DRIVE_FOLDER_ID;
  const r = spawnSync(process.execPath, ["-e", code], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "[]");
  assert.equal(fs.existsSync(path.join(dir, "data")), false);
});

test("the default instance is made lazily and is reused", () => {
  const { getLibraryIndex } = require("../lib/drive-index.js");
  assert.equal(typeof getLibraryIndex, "function");
});
