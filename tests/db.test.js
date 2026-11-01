const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { openDb, getDb, closeDb, migrate, dataDir } = require("../lib/db.js");

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "hvac-db-")); }

test("migrations run once", () => {
  const d = openDb(":memory:");
  assert.equal(migrate(d), 0); // openDb already applied them
});

test("a fresh database gets the user_state table", () => {
  const d = openDb(":memory:");
  const cols = d.prepare("PRAGMA table_info(user_state)").all().map((c) => c.name);
  assert.deepEqual(cols, ["user", "key", "value", "expires_at"]);
});

test("a file database is created with its folder, WAL on, and reopens without re-migrating", () => {
  const dir = tmp();
  const file = path.join(dir, "nested", "app.db");
  const a = openDb(file);
  assert.equal(a.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  a.exec("INSERT INTO user_state (user, key, value, expires_at) VALUES ('u','flow','{}',1)");
  a.close();
  const b = openDb(file);
  assert.equal(migrate(b), 0);
  assert.equal(b.prepare("SELECT COUNT(*) AS n FROM user_state").get().n, 1);
  b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("getDb opens lazily inside DATA_DIR and returns the same handle", () => {
  const dir = tmp();
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    assert.equal(dataDir(), dir);
    const a = getDb();
    assert.equal(getDb(), a);
    assert.ok(fs.existsSync(path.join(dir, "app.db")));
  } finally {
    closeDb();
    if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DATA_DIR defaults to ~/.hvac-assistant", () => {
  const prev = process.env.DATA_DIR;
  delete process.env.DATA_DIR;
  try { assert.equal(dataDir(), path.join(os.homedir(), ".hvac-assistant")); }
  finally { if (prev !== undefined) process.env.DATA_DIR = prev; }
});

test("requiring the modules and using the store opens no database and prints no warning", () => {
  const dir = path.join(tmp(), "never-created");
  const code = "const s=require('./lib/session-store.js');s.startFlow('u','split',{});s.getFlow('u');require('./lib/db.js');";
  const r = spawnSync(process.execPath, ["-e", code],
    { cwd: path.join(__dirname, ".."), env: { ...process.env, DATA_DIR: dir }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(fs.existsSync(dir), false);
});
