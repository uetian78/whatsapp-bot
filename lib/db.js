// ============================================================
//  SQLite database (node:sqlite, built into Node — no dependency).
//  - openDb(path?): opens a database, turns WAL on, runs the numbered
//    migrations once. ":memory:" is for tests.
//  - getDb(): the app's one shared handle, opened on first use inside
//    DATA_DIR. Nothing opens it at require time, so importing a module
//    never touches disk and the app can sleep and wake freely.
//  - migrate(db): applies the migrations the database hasn't seen and
//    returns how many it applied (0 when it is already current).
//  DATA_DIR defaults to ~/.hvac-assistant, not the repo: the repo sits in
//  OneDrive and synced folders can corrupt SQLite. Railway mounts a volume
//  and sets DATA_DIR to it.
// ============================================================

const fs = require("fs");
const os = require("os");
const path = require("path");

// Append only, never edit or reorder: the position is the version number
// (kept in PRAGMA user_version). Each entry runs once, in a transaction.
const MIGRATIONS = [
  (db) => db.exec(`
    CREATE TABLE user_state (
      user       TEXT    NOT NULL,
      key        TEXT    NOT NULL,
      value      TEXT    NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (user, key)
    )`),
  // One row per answered text-AI call (lib/ai.js). ts is epoch ms; the monthly
  // cap is the sum of cost_usd over the current UTC month.
  (db) => db.exec(`
    CREATE TABLE ai_usage (
      ts          INTEGER NOT NULL,
      purpose     TEXT    NOT NULL,
      model       TEXT    NOT NULL,
      input       INTEGER NOT NULL,
      output      INTEGER NOT NULL,
      cache_read  INTEGER NOT NULL,
      cache_write INTEGER NOT NULL,
      cost_usd    REAL    NOT NULL
    );
    CREATE INDEX ai_usage_ts ON ai_usage (ts)`),
  // The Drive library list (lib/drive-index.js), saved so a woken app doesn't
  // re-crawl Drive. seq keeps the crawl order; md5/size/modified_time are NULL
  // when Drive doesn't give them (native Google files have no md5). The
  // single library_state row holds when the list was last saved.
  (db) => db.exec(`
    CREATE TABLE library_files (
      id            TEXT    PRIMARY KEY,
      seq           INTEGER NOT NULL,
      name          TEXT    NOT NULL,
      folder        TEXT    NOT NULL,
      export_mime   TEXT,
      mime_type     TEXT,
      size          INTEGER,
      md5           TEXT,
      modified_time TEXT
    );
    CREATE INDEX library_files_seq ON library_files (seq);
    CREATE TABLE library_state (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      refreshed_at INTEGER NOT NULL
    )`),
  // Saved web conversations (lib/conversations.js). seq only ever goes up, so
  // the chat page can ask for "everything after the last one I have". body is
  // plain text for text/note and JSON for every other kind. generated_files
  // describes the bytes kept under DATA_DIR/generated (lib/channel-web.js).
  (db) => db.exec(`
    CREATE TABLE messages (
      seq  INTEGER PRIMARY KEY AUTOINCREMENT,
      user TEXT    NOT NULL,
      role TEXT    NOT NULL,
      kind TEXT    NOT NULL,
      body TEXT    NOT NULL,
      ts   INTEGER NOT NULL
    );
    CREATE INDEX messages_user_seq ON messages (user, seq);
    CREATE TABLE generated_files (
      id         TEXT    PRIMARY KEY,
      user       TEXT    NOT NULL,
      name       TEXT    NOT NULL,
      mime       TEXT    NOT NULL,
      size       INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX generated_files_created ON generated_files (created_at)`),
];

function dataDir() {
  return process.env.DATA_DIR || path.join(os.homedir(), ".hvac-assistant");
}

function migrate(db) {
  let version = db.prepare("PRAGMA user_version").get().user_version;
  let applied = 0;
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      MIGRATIONS[version](db);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    applied += 1;
  }
  return applied;
}

function openDb(file) {
  // Lazy: only code that opens a database loads the module (and sees any
  // ExperimentalWarning Node may print for it).
  const { DatabaseSync } = require("node:sqlite");
  const target = file || path.join(dataDir(), "app.db");
  if (target !== ":memory:") fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

let shared = null;

function getDb() {
  if (!shared) shared = openDb();
  return shared;
}

// For tests and shutdown: closes the shared handle so the next getDb() reopens.
function closeDb() {
  if (shared) { shared.close(); shared = null; }
}

module.exports = { openDb, getDb, closeDb, migrate, dataDir };
