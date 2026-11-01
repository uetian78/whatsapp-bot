// ============================================================
//  Reading the text of PDFs.
//  - extractPages(bytes): text of every page, using pdfjs-dist. This is what
//    runs inside the worker (lib/pdf-worker.js).
//  - readFileInWorker(file): the parent side. Streams a Drive PDF to a temp
//    file (never into memory), forks lib/pdf-worker.js on that path, and
//    returns the pages. A hung, crashing or chatty worker only fails that one
//    file: the child gets a memory ceiling and a time limit, and nothing it
//    prints reaches our logs (stdout/stderr are dropped, pdfjs is silent).
//    The PDF never travels over IPC: the worker reads the temp file itself.
// ============================================================
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { fork } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");

const MB = 1024 * 1024;
const WORKER = path.join(__dirname, "pdf-worker.js");
const WORKER_TIMEOUT_MS = 180_000;

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// The server's limits, from env. The PC build passes its own (no size limit,
// a roomy worker) straight to makeReadFile instead.
function pdfLimits(env = process.env) {
  return {
    maxBytes: positive(env.PDF_INDEX_MAX_MB, 10) * MB,
    memoryMb: positive(env.PDF_WORKER_MEMORY_MB, 256),
  };
}

// pdfjs-dist is ESM, so a CommonJS file loads it with a dynamic import. The
// legacy build runs on plain Node with no canvas.
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

// data: Uint8Array of a whole PDF. Returns one whitespace-collapsed string per
// page. A page whose text can't be read comes back as "" (counted as empty),
// so one odd page doesn't lose the other hundreds.
async function extractPages(data) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      let text = "";
      try {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        text = content.items.map((it) => (it.str || "") + (it.hasEOL ? "\n" : " ")).join("").replace(/\s+/g, " ").trim();
        page.cleanup();
      } catch (_) { /* leave the page empty */ }
      pages.push(text);
    }
    return pages;
  } finally {
    await doc.destroy().catch(() => {});
  }
}

// Stream a Drive file to dest. Counts bytes as they arrive so a file with no
// size in the list still can't fill the disk past maxBytes.
async function downloadDriveFile(file, dest, { maxBytes = Infinity } = {}) {
  const axios = require("axios");
  const { getGoogleAccessToken } = require("./google.js");
  const token = await getGoogleAccessToken();
  const res = await axios.get(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, {
    params: { alt: "media", supportsAllDrives: true },
    headers: { Authorization: `Bearer ${token}` },
    responseType: "stream",
    timeout: 60_000,
    signal: AbortSignal.timeout(10 * 60_000),
    maxRedirects: 5,
  });
  let seen = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) return cb(Object.assign(new Error("PDF is larger than the size limit"), { code: "TOO_LARGE" }));
      cb(null, chunk);
    },
  });
  await pipeline(res.data, counter, fs.createWriteStream(dest));
}

// Run the worker on one PDF already on disk. Resolves with the pages; rejects
// on a worker error, a crash, a kill, a time-out or a message we don't expect.
function runWorker(pdfPath, { workerPath = WORKER, memoryMb, timeoutMs = WORKER_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [], {
      execArgv: [`--max-old-space-size=${memoryMb}`],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch (_) { /* already gone */ }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`PDF reader took too long (over ${Math.round(timeoutMs / 1000)} s) and was stopped`)), timeoutMs);
    child.on("message", (m) => {
      if (m && m.ok === true && Array.isArray(m.pages) && m.pages.every((p) => typeof p === "string")) return finish(resolve, m.pages);
      if (m && m.ok === false) return finish(reject, new Error(String(m.error || "PDF could not be read").slice(0, 200)));
      finish(reject, new Error("PDF reader sent an unexpected message"));
    });
    child.on("error", (err) => finish(reject, new Error(`PDF reader could not start: ${err.message}`)));
    child.on("exit", (code, signal) =>
      finish(reject, new Error(`PDF reader stopped before finishing (${signal ? `signal ${signal}` : `exit code ${code}`})`)));
    child.send({ path: pdfPath }, (err) => { if (err) finish(reject, new Error("PDF reader could not be told what to read")); });
  });
}

// file: a library File. Resolves with the pages of the PDF; the temp copy is
// always removed. Options are for tests and for the PC build.
async function readFileInWorker(file, opts = {}) {
  const {
    download = downloadDriveFile,
    workerPath,
    memoryMb = pdfLimits().memoryMb,
    timeoutMs,
    maxBytes,
    tmpDir = os.tmpdir(),
  } = opts;
  const dest = path.join(tmpDir, `pdf-${crypto.randomUUID()}.pdf`);
  try {
    await download(file, dest, { maxBytes });
    return await runWorker(dest, { workerPath, memoryMb, timeoutMs });
  } finally {
    fs.rmSync(dest, { force: true });
  }
}

// A readFile(file) for createPageIndex. timeoutMs may also come from
// PDF_WORKER_TIMEOUT_S, for a PC run over very large catalogues.
function makeReadFile({ memoryMb, maxBytes, timeoutMs } = {}) {
  const limits = pdfLimits();
  const opts = {
    memoryMb: memoryMb ?? limits.memoryMb,
    maxBytes: maxBytes ?? limits.maxBytes,
    timeoutMs: timeoutMs ?? positive(process.env.PDF_WORKER_TIMEOUT_S, WORKER_TIMEOUT_MS / 1000) * 1000,
  };
  return (file) => readFileInWorker(file, opts);
}

module.exports = { extractPages, readFileInWorker, makeReadFile, pdfLimits, downloadDriveFile };
