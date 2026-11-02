// ============================================================
//  Page-level search over the Drive PDFs, on SQLite FTS5.
//  - createPageIndex(...): sync(files) records which PDFs exist and which need
//    reading (new or changed md5); runNext()/drain() read them one at a time
//    through the injected readFile; search(query) finds pages.
//  - The index lives in its own file (DATA_DIR/search.db), apart from app.db,
//    so the PC can build the whole library once and upload that single file.
//    It always uses journal_mode=DELETE, so the file is complete on its own.
//  - replaceDb(path) swaps an uploaded file in; createUploadHandler is the
//    admin endpoint that receives it (POST /admin/search-index).
//  - With no index file yet, search() is [] and status() is zeros; nothing
//    creates the file until sync() has a PDF to record.
//  Scanned pages (under 20 characters of text) are counted but not stored:
//  those files are found by file name in the existing searches.
// ============================================================
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { meaningfulTokens } = require("./broad-search.js");

const MB = 1024 * 1024;
const MIN_PAGE_CHARS = 20;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS doc_files (
    id          TEXT PRIMARY KEY,
    md5         TEXT,
    status      TEXT NOT NULL,
    pages       INTEGER,
    empty_pages INTEGER,
    error       TEXT,
    indexed_at  INTEGER,
    name        TEXT NOT NULL,
    folder      TEXT NOT NULL,
    size        INTEGER
  );
  CREATE INDEX IF NOT EXISTS doc_files_status ON doc_files (status);
  CREATE VIRTUAL TABLE IF NOT EXISTS doc_pages USING fts5(name, folder, body, file_id UNINDEXED, page UNINDEXED);
`;

const REQUIRED_COLUMNS = {
  doc_files: ["id", "md5", "status", "pages", "empty_pages", "error", "indexed_at", "name", "folder", "size"],
  doc_pages: ["name", "folder", "body", "file_id", "page"],
};

const ZERO_STATUS = () => ({ total: 0, indexed: 0, noText: 0, tooLarge: 0, failed: 0, pages: 0, emptyPages: 0 });

function codeError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Opens (creating if needed) a search database. ":memory:" is for tests.
function openSearchDb(file) {
  const { DatabaseSync } = require("node:sqlite");
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (file !== ":memory:") db.exec("PRAGMA journal_mode = DELETE");
    db.exec(SCHEMA);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

// Throws BAD_INDEX unless the file opens read-only and has the tables and
// columns this module reads. Document text is never put in the message.
function validateIndexFile(file) {
  const { DatabaseSync } = require("node:sqlite");
  let probe = null;
  try {
    probe = new DatabaseSync(file, { readOnly: true });
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      const have = probe.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      const missing = columns.filter((c) => !have.includes(c));
      if (!have.length) throw new Error(`table ${table} is missing`);
      if (missing.length) throw new Error(`table ${table} lacks column ${missing[0]}`);
    }
    probe.prepare("SELECT COUNT(*) AS n FROM doc_files").get();
    probe.prepare("SELECT file_id FROM doc_pages WHERE doc_pages MATCH ? LIMIT 1").all('"x"');
  } catch (err) {
    throw codeError("BAD_INDEX", `That file is not a usable search index (${String(err.message).slice(0, 120)}).`);
  } finally {
    if (probe) { try { probe.close(); } catch (_) { /* already unusable */ } }
  }
}

const isPdf = (f) =>
  !!f && !f.exportMime && (f.mimeType ? f.mimeType === "application/pdf" : /\.pdf$/i.test(f.name || ""));

// SQL to keep rows whose folder path has a Catalogue(s) / IOM(s) segment.
// Mirrors folderMatchesDocType in lib/drive-index.js.
const DOC_TYPE_SQL = {
  Catalogue: "('/' || lower(folder) || '/') LIKE '%/catalogue/%' OR ('/' || lower(folder) || '/') LIKE '%/catalogues/%' OR ('/' || lower(folder) || '/') LIKE '%/catalog/%'",
  IOM: "('/' || lower(folder) || '/') LIKE '%/iom/%' OR ('/' || lower(folder) || '/') LIKE '%/ioms/%'",
};

function defaultFreeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch (_) {
    return Infinity;
  }
}

async function defaultCopy(from, to) {
  await pipeline(fs.createReadStream(from), fs.createWriteStream(to));
}

// path: where the index file lives (opened on first use), or db: an open
// database (tests). readFile(file) -> Promise<string[]> pages. maxBytes: PDFs
// bigger than this are marked tooLarge instead of read. fsOps: test hooks.
function createPageIndex({ path: dbPath = null, db: injected = null, readFile, maxBytes = 10 * MB, fsOps = {} }) {
  const ops = {
    rename: fsOps.rename || fs.renameSync,
    copy: fsOps.copy || defaultCopy,
    freeBytes: fsOps.freeBytes || defaultFreeBytes,
  };
  let db = injected;
  let draining = null;

  // The open database. With create false it returns null when there is no
  // index file yet, and creates nothing.
  function conn(create) {
    if (db) return db;
    if (!dbPath) return null;
    if (!create && !fs.existsSync(dbPath)) return null;
    db = openSearchDb(dbPath);
    return db;
  }

  function exists() {
    return !!db || (!!dbPath && fs.existsSync(dbPath));
  }

  function transaction(d, fn) {
    d.exec("BEGIN");
    try {
      const out = fn();
      d.exec("COMMIT");
      return out;
    } catch (err) {
      try { d.exec("ROLLBACK"); } catch (_) { /* nothing open */ }
      throw err;
    }
  }

  function deletePages(d, ids) {
    // file_id is not indexed, so each delete scans the pages: do many ids at once.
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      d.prepare(`DELETE FROM doc_pages WHERE file_id IN (${chunk.map(() => "?").join(",")})`).run(...chunk);
    }
  }

  // Record the PDFs in `files`. New and changed (md5) ones are queued; files
  // that vanished are dropped with their pages unless prune is false (a
  // partial list). A list with no PDFs in it never prunes: an empty crawl is a
  // Drive hiccup far more often than an emptied library, and pruning would
  // wipe every indexed page. A tooLarge file is queued again once maxBytes
  // allows it, a failed one only with retryFailed. Non-PDFs are ignored.
  function sync(files, { prune = true, retryFailed = false } = {}) {
    const pdfs = (files || []).filter(isPdf);
    const d = conn(pdfs.length > 0);
    if (!d) return { queued: 0, removed: 0 };
    if (prune && !pdfs.length) {
      prune = false;
      console.error("⚠️  Page search sync got a list with no PDFs; keeping every indexed file");
    }
    const known = new Map(d.prepare("SELECT id, md5, status, name, folder, size FROM doc_files").all().map((r) => [r.id, r]));
    let queued = 0;
    const renamed = [];
    const seen = new Set();
    transaction(d, () => {
      const insert = d.prepare("INSERT INTO doc_files (id, md5, status, name, folder, size) VALUES (?, ?, 'pending', ?, ?, ?)");
      const requeue = d.prepare("UPDATE doc_files SET status = 'pending', error = NULL, md5 = ? WHERE id = ?");
      const touch = d.prepare("UPDATE doc_files SET name = ?, folder = ?, size = ? WHERE id = ?");
      for (const f of pdfs) {
        seen.add(f.id);
        const size = f.size != null && Number.isFinite(Number(f.size)) ? Number(f.size) : null;
        const row = known.get(f.id);
        if (!row) {
          insert.run(f.id, f.md5 || null, f.name, f.folder || "", size);
          queued += 1;
          continue;
        }
        const changed = !!f.md5 && f.md5 !== row.md5;
        const nowAllowed = row.status === "tooLarge" && !(size != null && size > maxBytes);
        const retry = row.status === "failed" && retryFailed;
        if (changed || nowAllowed || retry) {
          requeue.run(f.md5 || row.md5, f.id);
          queued += 1;
        }
        if (row.name !== f.name || row.folder !== (f.folder || "") || row.size !== size) {
          touch.run(f.name, f.folder || "", size, f.id);
          if (row.name !== f.name || row.folder !== (f.folder || "")) renamed.push(f);
        }
      }
      for (const f of renamed) {
        d.prepare("UPDATE doc_pages SET name = ?, folder = ? WHERE file_id = ?").run(f.name, f.folder || "", f.id);
      }
    });
    let removed = 0;
    if (prune) {
      const gone = [...known.keys()].filter((id) => !seen.has(id));
      if (gone.length) {
        transaction(d, () => {
          deletePages(d, gone);
          for (let i = 0; i < gone.length; i += 200) {
            const chunk = gone.slice(i, i + 200);
            d.prepare(`DELETE FROM doc_files WHERE id IN (${chunk.map(() => "?").join(",")})`).run(...chunk);
          }
        });
        removed = gone.length;
      }
    }
    return { queued, removed };
  }

  // Give a queued file its final non-indexed state, dropping any pages it had.
  function settle(d, row, status, error = null) {
    transaction(d, () => {
      if ((row.pages || 0) - (row.empty_pages || 0) > 0) deletePages(d, [row.id]);
      d.prepare("UPDATE doc_files SET status = ?, pages = NULL, empty_pages = NULL, error = ?, indexed_at = ? WHERE id = ?")
        .run(status, error, Date.now(), row.id);
    });
  }

  function store(d, row, pages) {
    const texts = pages.map((p) => (p || "").trim());
    const usable = texts.map((t, i) => ({ t, page: i + 1 })).filter((p) => p.t.length >= MIN_PAGE_CHARS);
    const empty = texts.length - usable.length;
    transaction(d, () => {
      if ((row.pages || 0) - (row.empty_pages || 0) > 0) deletePages(d, [row.id]);
      const insert = d.prepare("INSERT INTO doc_pages (name, folder, body, file_id, page) VALUES (?, ?, ?, ?, ?)");
      for (const p of usable) insert.run(row.name, row.folder, p.t, row.id, p.page);
      d.prepare("UPDATE doc_files SET status = ?, pages = ?, empty_pages = ?, error = NULL, indexed_at = ? WHERE id = ?")
        .run(usable.length ? "indexed" : "noText", texts.length, empty, Date.now(), row.id);
    });
  }

  // Read the next queued file. Resolves true if there was one (whatever came
  // of it), false when the queue is empty.
  async function runNext() {
    const d = conn(false);
    if (!d) return false;
    const row = d.prepare("SELECT * FROM doc_files WHERE status = 'pending' ORDER BY rowid LIMIT 1").get();
    if (!row) return false;
    if (row.size != null && row.size > maxBytes) {
      settle(d, row, "tooLarge");
      return true;
    }
    const file = { id: row.id, name: row.name, folder: row.folder, size: row.size ?? undefined, md5: row.md5 ?? undefined, mimeType: "application/pdf" };
    let pages = null, failure = null;
    try {
      pages = await readFile(file);
    } catch (err) {
      failure = err;
    }
    // The index may have been swapped or the file changed while it was read.
    const now = conn(false);
    const current = now && now.prepare("SELECT * FROM doc_files WHERE id = ?").get(row.id);
    if (!current || current.md5 !== row.md5 || current.status !== "pending") return true;
    if (failure) {
      if (failure.code === "TOO_LARGE") settle(now, current, "tooLarge");
      else settle(now, current, "failed", String(failure.message || failure).slice(0, 200));
      return true;
    }
    store(now, current, Array.isArray(pages) ? pages : []);
    return true;
  }

  // Work through the whole queue, one file at a time. Callers share one run.
  function drain() {
    if (!draining) {
      draining = (async () => {
        try {
          while (await runNext());
        } catch (err) {
          console.error("PDF indexing stopped:", err && err.message);
        } finally {
          draining = null;
        }
      })();
    }
    return draining;
  }

  function matchQuery(tokens, joiner) {
    return tokens.map((t) => `"${t}"`).join(joiner);
  }

  // Pages matching the query: every word first, then (unless anyWord is false)
  // any word. At most perFile pages of one file come back, best first, so a
  // query that matches a file's name (weight 5) cannot fill the list with that
  // file's first pages. textChars > 0 adds each page's text, cut to that length.
  function search(query, { limit = 8, docType = null, perFile = 2, anyWord = true, textChars = 0 } = {}) {
    try {
      const tokens = [...new Set(meaningfulTokens(query))];
      if (!tokens.length) return [];
      if (docType && !DOC_TYPE_SQL[docType]) return [];
      const d = conn(false);
      if (!d) return [];
      const cap = Number.isInteger(limit) && limit > 0 ? limit : 8;
      const per = Number.isInteger(perFile) && perFile > 0 ? perFile : 2;
      const chars = Number.isInteger(textChars) && textChars > 0 ? textChars : 0;
      // Rank every matching page, number each file's pages by rank, keep the
      // first perFile of each. Snippets and text are read only for the survivors.
      const ranked = d.prepare(
        "WITH m AS (SELECT rowid AS rid, file_id, bm25(doc_pages, 5, 1, 1) AS rank FROM doc_pages WHERE doc_pages MATCH ? " +
        (docType ? `AND (${DOC_TYPE_SQL[docType]}) ` : "") + "), " +
        "r AS (SELECT rid, rank, ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY rank, rid) AS n FROM m) " +
        "SELECT rid FROM r WHERE n <= ? ORDER BY rank, rid LIMIT ?"
      );
      let match = matchQuery(tokens, " AND ");
      let rows = ranked.all(match, per, cap);
      if (!rows.length && anyWord && tokens.length > 1) {
        match = matchQuery(tokens, " OR ");
        rows = ranked.all(match, per, cap);
      }
      if (!rows.length) return [];
      const one = d.prepare(
        "SELECT file_id, name, folder, page, snippet(doc_pages, 2, '', '', ' … ', 24) AS snippet, substr(body, 1, ?) AS text " +
        "FROM doc_pages WHERE doc_pages MATCH ? AND rowid = ?"
      );
      const sizeOf = d.prepare("SELECT size FROM doc_files WHERE id = ?");
      const out = [];
      for (const { rid } of rows) {
        // BigInt: FTS5 only applies a rowid constraint given an integer, and a
        // plain JS number is bound as a float.
        const r = one.get(chars || 1, match, BigInt(rid));
        if (!r) continue;
        const hit = {
          fileId: r.file_id,
          name: r.name,
          folder: r.folder,
          page: Number(r.page),
          snippet: r.snippet,
          size: (sizeOf.get(r.file_id) || {}).size ?? null,
        };
        if (chars) hit.text = r.text;
        out.push(hit);
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  function status() {
    const d = conn(false);
    if (!d) return ZERO_STATUS();
    const r = d.prepare(
      "SELECT COUNT(*) AS total, " +
      "COALESCE(SUM(status = 'indexed'), 0) AS indexed, COALESCE(SUM(status = 'noText'), 0) AS noText, " +
      "COALESCE(SUM(status = 'tooLarge'), 0) AS tooLarge, COALESCE(SUM(status = 'failed'), 0) AS failed, " +
      "COALESCE(SUM(pages), 0) AS pages, COALESCE(SUM(empty_pages), 0) AS emptyPages FROM doc_files"
    ).get();
    return { total: r.total, indexed: r.indexed, noText: r.noText, tooLarge: r.tooLarge, failed: r.failed, pages: r.pages, emptyPages: r.emptyPages };
  }

  // Files that could not be read: [{ id, error }]. Ids only, no names or text.
  function failures() {
    const d = conn(false);
    if (!d) return [];
    return d.prepare("SELECT id, error FROM doc_files WHERE status = 'failed' ORDER BY rowid").all()
      .map((r) => ({ id: r.id, error: r.error }));
  }

  // Tidy the file for upload: merge the search segments (smaller, faster) and
  // leave one self-contained file with no journal beside it.
  function compact() {
    const d = conn(false);
    if (!d) return;
    d.exec("INSERT INTO doc_pages (doc_pages) VALUES ('optimize')");
    d.exec("PRAGMA journal_mode = DELETE");
    d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  // Swap in another index file. It must open read-only and have the expected
  // tables; otherwise this throws and the current index keeps working. The new
  // file is first brought next to the live one (renamed if possible, copied if
  // not and only when the volume has room), so the live file is only replaced
  // by a complete file in one rename. The caller removes `newPath` if it is
  // still there.
  async function replaceDb(newPath) {
    if (!dbPath) throw codeError("NO_PATH", "This index has no file to replace.");
    validateIndexFile(newPath);
    const staged = `${dbPath}.incoming`;
    const kept = "the old search index is still in use";
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.rmSync(staged, { force: true });
    try {
      try {
        ops.rename(newPath, staged);
      } catch (_) {
        // Different filesystem (the upload sits in the container's temp folder).
        const need = fs.statSync(newPath).size;
        const free = ops.freeBytes(path.dirname(dbPath));
        if (free < need + MB) {
          throw codeError("NO_ROOM", `Not enough room on the data volume to hold the new search index beside the old one ` +
            `(needs ${Math.ceil(need / MB)} MB, ${Math.max(0, Math.floor(free / MB))} MB free); ${kept}.`);
        }
        try {
          await ops.copy(newPath, staged);
          if (fs.statSync(staged).size !== need) throw new Error("the copy came out the wrong size");
        } catch (err) {
          throw codeError("SWAP_FAILED", `Copying the new search index onto the data volume failed (${String(err.message).slice(0, 120)}); ${kept}.`);
        }
      }
      validateIndexFile(staged);
      if (db && !injected) { db.close(); db = null; }
      // A leftover journal from the old file would corrupt the new one.
      for (const ext of ["-journal", "-wal", "-shm"]) fs.rmSync(dbPath + ext, { force: true });
      try {
        ops.rename(staged, dbPath);
      } catch (err) {
        throw codeError("SWAP_FAILED", `Putting the new search index in place failed (${String(err.message).slice(0, 120)}); ${kept}.`);
      }
    } catch (err) {
      fs.rmSync(staged, { force: true });
      throw err;
    }
    db = null;
    conn(true); // reopen now, so a problem shows here
  }

  function close() {
    if (db && !injected) { db.close(); db = null; }
  }

  return { sync, runNext, drain, search, status, failures, compact, replaceDb, exists, close };
}

// ── the upload endpoint ─────────────────────────────────────────────────

function uploadLimitBytes(env = process.env) {
  const n = Number(env.SEARCH_INDEX_MAX_MB);
  return (Number.isFinite(n) && n > 0 ? n : 400) * MB;
}

// Copy the request body to dest, stopping at maxBytes. Rejects with TOO_BIG.
function receiveToFile(req, dest, maxBytes) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    let seen = 0, over = false, failed = false;
    const fail = (err) => { if (!failed) { failed = true; out.destroy(); reject(err); } };
    req.on("data", (chunk) => {
      if (over || failed) return; // keep draining so the client can read our answer
      seen += chunk.length;
      if (seen > maxBytes) {
        over = true;
        return fail(codeError("TOO_BIG", "too big"));
      }
      if (!out.write(chunk)) {
        req.pause();
        out.once("drain", () => req.resume());
      }
    });
    req.on("end", () => { if (!failed) out.end(() => resolve(seen)); });
    req.on("error", fail);
    req.on("aborted", () => fail(new Error("The upload was cut off.")));
    out.on("error", fail);
  });
}

// Express handler: streams the body to a temp file in os.tmpdir() (not memory,
// not the data volume), validates it there, then swaps it in. The temp file is
// always removed. Replies with status() as JSON, which holds no document text.
function createUploadHandler({ index, maxBytes = uploadLimitBytes(), tmpDir = null }) {
  return async (req, res) => {
    const limitMb = Math.round(maxBytes / MB);
    const tooBig = () => {
      res.set("Connection", "close");
      return res.status(413).json({ error: `The search index is larger than the limit of ${limitMb} MB. Raise SEARCH_INDEX_MAX_MB to allow it.` });
    };
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) return tooBig();
    const tmp = path.join(tmpDir || os.tmpdir(), `search-upload-${crypto.randomUUID()}.db`);
    try {
      await receiveToFile(req, tmp, maxBytes);
      await index.replaceDb(tmp);
      const status = index.status();
      console.log(`🔎 Search index replaced: ${status.total} files, ${status.pages} pages`);
      return res.json(status);
    } catch (err) {
      if (err.code === "TOO_BIG") return tooBig();
      console.error("Search index upload failed:", err.code || "", err.message);
      if (err.code === "BAD_INDEX") return res.status(400).json({ error: err.message });
      if (err.code === "NO_ROOM") return res.status(507).json({ error: err.message });
      if (err.code === "SWAP_FAILED") return res.status(500).json({ error: err.message });
      return res.status(500).json({ error: "The search index could not be replaced." });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  };
}

// The app's own instance, made on first use so requiring this module opens
// nothing. It reads and writes DATA_DIR/search.db.
let shared = null;
function getPageIndex() {
  if (!shared) {
    const { dataDir } = require("./db.js");
    const { makeReadFile, pdfLimits } = require("./pdf-text.js");
    shared = createPageIndex({
      path: path.join(dataDir(), "search.db"),
      readFile: makeReadFile(),
      maxBytes: pdfLimits().maxBytes,
    });
  }
  return shared;
}

module.exports = { createPageIndex, openSearchDb, createUploadHandler, uploadLimitBytes, getPageIndex };
