// ============================================================
//  Just the matching page: a one-page PDF (qpdf) or a JPEG (pdftoppm) out of a
//  Drive PDF, so nobody has to open or share a 96 MB catalogue for one table.
//
//  The Drive file is streamed to a temp file (never held in memory: Railway
//  Free has 0.5 GB), the tool reads it from disk, and only the small one-page
//  result is read back. One job at a time across all users; a queued person
//  waits. Finished pages are cached under DATA_DIR/page-cache, capped by
//  PAGE_CACHE_MB (default 100), oldest removed first.
//
//  File ids and page numbers arrive from button taps, so they are untrusted:
//  the page must be a plain positive integer, the id a plain Drive id, and no
//  user value is ever used as part of a path (cache names are hashes, the temp
//  folder is made by the OS).
// ============================================================
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream/promises");

const MSG_BAD_PAGE = "That page isn't in this file.";
const MSG_FAILED = "Couldn't get that page. Open the full file instead.";
const MSG_NOT_PDF = "I can only cut pages out of PDF files. Open the full file instead.";
const MSG_NO_FILE = "I can't find that file in the library any more.";

const TOOL_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_CACHE_MB = 100;
const OUTPUT_CAP = 500;                    // chars of tool output kept, for errors only
const MAX_OUTPUT_BYTES = 30 * 1024 * 1024; // a one-page result is small; anything this big is not one
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PAGE_RE = /^[1-9]\d{0,5}$/;

// Carries the sentence that is safe to show the person; `message` keeps detail for the log.
class PageError extends Error {
  constructor(userMessage, detail) {
    super(detail || userMessage);
    this.name = "PageError";
    this.userMessage = userMessage;
  }
}

// Tap ids: page|<fileId>|<n>|pdf and page|<fileId>|<n>|image.
function pageTapId(fileId, page, format) {
  return `page|${fileId}|${page}|${format}`;
}

// Shape only: the page is validated (again) when the page is fetched.
function parsePageTap(tapId) {
  if (typeof tapId !== "string") return null;
  const parts = tapId.split("|");
  if (parts.length !== 4 || parts[0] !== "page") return null;
  const [, fileId, page, format] = parts;
  if (!ID_RE.test(fileId) || (format !== "pdf" && format !== "image")) return null;
  return { fileId, page, format };
}

function parsePage(page) {
  const s = typeof page === "number" ? String(page) : page;
  if (typeof s !== "string" || !PAGE_RE.test(s)) throw new PageError(MSG_BAD_PAGE);
  return Number(s);
}

function isPdf(file) {
  if (file.exportMime) return false; // Google-native: no PDF bytes to cut
  if (file.mimeType) return file.mimeType === "application/pdf";
  return /\.pdf$/i.test(file.name || "");
}

// "<file name> - page 14.pdf": the .pdf extension off the name first, anything
// that is unsafe in a file name replaced.
function pageFilename(name, page, format) {
  const base = String(name || "")
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120) || "page";
  return `${base} - page ${page}.${format === "pdf" ? "pdf" : "jpg"}`;
}

// Default runner: no shell, args as an array, killed after timeoutMs. Output is
// only kept (capped) for error messages; it never grows with the tool's output.
// Always resolves: { code, stdout, stderr, timedOut, error? }.
function defaultRun(cmd, args, { timeoutMs = TOOL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const keep = (have, chunk) => (have.length >= OUTPUT_CAP ? have : (have + chunk.toString()).slice(0, OUTPUT_CAP));
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(cmd, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      return finish({ code: -1, stdout, stderr, timedOut, error: err.code || err.message });
    }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (c) => { stdout = keep(stdout, c); });
    child.stderr.on("data", (c) => { stderr = keep(stderr, c); });
    child.on("error", (err) => finish({ code: -1, stdout, stderr, timedOut, error: err.code || err.message }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut }));
  });
}

function cacheMbFromEnv() {
  const n = Number(process.env.PAGE_CACHE_MB);
  return process.env.PAGE_CACHE_MB !== undefined && process.env.PAGE_CACHE_MB !== "" && Number.isFinite(n) && n >= 0
    ? n : DEFAULT_CACHE_MB;
}

function createPageExtractor({
  run = defaultRun,
  stream,
  dataDir,
  now = Date.now,
  library,
  cacheMb = cacheMbFromEnv(),
  toolTimeoutMs = TOOL_TIMEOUT_MS,
  downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS,
} = {}) {
  // Everything heavy is looked up on first use, so importing this module (and
  // building the shared instance) touches no database, folder or network.
  const streamFile = stream || ((id) => require("./google.js").streamDriveFile(id));
  const lib = () => library || require("./drive-index.js").getLibraryIndex();
  const root = () => {
    const base = typeof dataDir === "function" ? dataDir() : dataDir || require("./db.js").dataDir();
    return path.join(base, "page-cache");
  };

  // The library knows the file; a tap's id alone is not trusted. findById is
  // synchronous and empty until a list exists, so wait for the list once.
  async function findFile(fileId) {
    if (typeof fileId !== "string" || !ID_RE.test(fileId)) return null;
    const idx = lib();
    let file = idx.findById(fileId);
    if (!file) {
      await idx.list();
      file = idx.findById(fileId);
    }
    return file || null;
  }

  // ---- cache ----
  const cacheFile = (file, page, format) => {
    const key = crypto.createHash("sha256").update(`${file.id}\n${file.md5 || ""}\n${page}\n${format}`).digest("hex");
    return path.join(root(), `${key}.${format === "pdf" ? "pdf" : "jpg"}`);
  };

  async function cacheRead(target) {
    try { return await fsp.readFile(target); } catch (_) { return null; }
  }

  async function cacheWrite(target, buffer) {
    try {
      await fsp.mkdir(root(), { recursive: true });
      const tmp = `${target}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fsp.writeFile(tmp, buffer);
      await fsp.rename(tmp, target);
      const stamp = new Date(now());
      await fsp.utimes(target, stamp, stamp);
      await trimCache();
    } catch (err) {
      console.error("Page cache write failed:", err && err.message); // the page itself still goes out
    }
  }

  async function trimCache() {
    const cap = cacheMb * 1024 * 1024;
    const dir = root();
    const entries = [];
    for (const name of await fsp.readdir(dir)) {
      try {
        const st = await fsp.stat(path.join(dir, name));
        if (st.isFile()) entries.push({ name, size: st.size, at: st.mtimeMs });
      } catch (_) { /* gone already */ }
    }
    let total = entries.reduce((n, e) => n + e.size, 0);
    entries.sort((a, b) => a.at - b.at);
    for (const e of entries) {
      if (total <= cap) break;
      try { await fsp.rm(path.join(dir, e.name), { force: true }); total -= e.size; } catch (_) { /* leave it */ }
    }
  }

  // ---- one job: download, count pages, cut ----
  async function download(fileId, dest) {
    const ac = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => { ac.abort(); reject(new Error("download timed out")); }, downloadTimeoutMs);
    });
    const work = (async () => {
      const readable = await streamFile(fileId);
      if (ac.signal.aborted) { readable.destroy(); throw new Error("download timed out"); }
      await pipeline(readable, fs.createWriteStream(dest), { signal: ac.signal });
    })();
    work.catch(() => {}); // when the timeout wins, its late failure must not go unhandled
    try {
      await Promise.race([work, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function tool(cmd, args) {
    let r;
    try {
      r = await run(cmd, args, { timeoutMs: toolTimeoutMs });
    } catch (err) {
      throw new PageError(MSG_FAILED, `${cmd} could not run: ${err && err.message}`);
    }
    // qpdf exits 3 for "finished with warnings"; the output is still good.
    const ok = r && !r.timedOut && !r.error && (r.code === 0 || (cmd === "qpdf" && r.code === 3));
    if (!ok) {
      const why = !r ? "no result" : r.timedOut ? "timed out" : r.error ? r.error : `exit ${r.code}`;
      throw new PageError(MSG_FAILED, `${cmd} failed (${why}) ${String((r && r.stderr) || "").slice(0, 200)}`.trim());
    }
    return r;
  }

  async function pageCount(src) {
    const r = await tool("qpdf", ["--show-npages", src]);
    const text = String(r.stdout || "").trim();
    if (!/^\d{1,7}$/.test(text)) throw new PageError(MSG_FAILED, `qpdf gave no page count: "${text.slice(0, 40)}"`);
    return Number(text);
  }

  async function cut(file, page, format) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hvac-pagecut-"));
    try {
      const src = path.join(dir, "source.pdf");
      try {
        await download(file.id, src);
      } catch (err) {
        throw new PageError(MSG_FAILED, `download failed: ${err && err.message}`);
      }
      if (page > (await pageCount(src))) throw new PageError(MSG_BAD_PAGE);

      let produced;
      if (format === "pdf") {
        produced = path.join(dir, "page.pdf");
        await tool("qpdf", ["--empty", "--pages", src, String(page), "--", produced]);
      } else {
        const outBase = path.join(dir, "page");
        produced = `${outBase}.jpg`; // -singlefile adds the extension
        await tool("pdftoppm", ["-f", String(page), "-l", String(page), "-singlefile", "-r", "150", "-jpeg", src, outBase]);
      }
      let size;
      try { size = (await fsp.stat(produced)).size; } catch (_) { size = 0; }
      if (!size) throw new PageError(MSG_FAILED, "the tool wrote no page");
      if (size > MAX_OUTPUT_BYTES) throw new PageError(MSG_FAILED, `the page came out at ${size} bytes`);
      return await fsp.readFile(produced);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    }
  }

  // One job at a time, across users. A failed job never blocks the next.
  let tail = Promise.resolve();
  function queued(fn) {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  }

  // getPage({ file, page, format }) or getPage({ fileId, page, format }).
  // Rejects with a PageError whose userMessage can be shown as is.
  async function getPage({ file, fileId, page, format = "pdf" }) {
    const n = parsePage(page);
    if (format !== "pdf" && format !== "image") throw new PageError(MSG_FAILED, `unknown format ${String(format).slice(0, 20)}`);
    const entry = file || (await findFile(fileId));
    if (!entry || typeof entry.id !== "string" || !ID_RE.test(entry.id)) throw new PageError(MSG_NO_FILE);
    if (!isPdf(entry)) throw new PageError(MSG_NOT_PDF);

    const filename = pageFilename(entry.name, n, format);
    const target = cacheFile(entry, n, format);
    let buffer = await cacheRead(target);
    if (!buffer) {
      buffer = await queued(async () => {
        // Someone ahead of us in the queue may have just made this very page.
        const again = await cacheRead(target);
        if (again) return again;
        const fresh = await cut(entry, n, format);
        await cacheWrite(target, fresh);
        return fresh;
      }).catch((err) => {
        if (err instanceof PageError) {
          if (err.userMessage === MSG_FAILED) console.error("Page extract failed:", String(err.message).slice(0, 300));
          throw err;
        }
        console.error("Page extract failed:", err && err.message);
        throw new PageError(MSG_FAILED, err && err.message);
      });
    }
    return { buffer, filename };
  }

  return { getPage, cacheMb };
}

let shared = null;
function getPageExtractor() {
  if (!shared) shared = createPageExtractor();
  return shared;
}

module.exports = {
  createPageExtractor, getPageExtractor, defaultRun, PageError, pageTapId, parsePageTap,
  MSG_BAD_PAGE, MSG_FAILED,
};
