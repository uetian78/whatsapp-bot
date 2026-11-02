// Reads every PDF in the Drive library on THIS computer, builds the page-search
// file, and uploads it to the running app. The app (Railway Free, 0.5 GB) never
// has to read the whole library itself.
//
//   node scripts/build-index.js [--no-upload] [--limit N] [--no-retry]
//
//   --no-upload  build DATA_DIR/search.db and stop (prove it works first).
//   --limit N    only the first N PDFs of the library, to try it out. The rest
//                of an existing search.db is left alone. Implies --no-upload:
//                a partial file must never replace the app's full one.
//   --no-retry   don't try files that failed last time again.
//
// It saves as it goes, so stopping it (Ctrl+C) and running it again carries on
// where it stopped; unchanged files are never read twice. No size limit here,
// and each PDF gets a 2 GB reader. Reads .env for Google access (and
// PUBLIC_URL + ADMIN_PASSWORD for the upload; the password is never printed).
// Logs counts and file ids only, never document text or file names.
const fs = require("node:fs");
const path = require("node:path");

const WORKER_MEMORY_MB = 2048;

function parseArgs(argv) {
  const opts = { upload: true, limit: null, retryFailed: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-upload") opts.upload = false;
    else if (a === "--no-retry") opts.retryFailed = false;
    else if (a === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error("--limit needs a whole number of 1 or more");
      opts.limit = n;
    } else throw new Error(`Unknown option ${a}`);
  }
  // A partial index uploaded by habit would replace the app's whole one.
  if (opts.limit && opts.upload) {
    opts.upload = false;
    opts.limitImpliedNoUpload = true;
  }
  return opts;
}

async function upload(file) {
  const axios = require("axios");
  const { PUBLIC_URL, ADMIN_PASSWORD } = process.env;
  if (!PUBLIC_URL || !ADMIN_PASSWORD) throw new Error("PUBLIC_URL and ADMIN_PASSWORD must be set in .env to upload (or use --no-upload)");
  const url = new URL("/admin/search-index", PUBLIC_URL).href;
  const size = fs.statSync(file).size;
  console.log(`Uploading ${(size / 1048576).toFixed(1)} MB to ${new URL(url).origin} ...`);
  let res;
  try {
    res = await axios.post(url, fs.createReadStream(file), {
      headers: { "Content-Type": "application/octet-stream", "Content-Length": size },
      auth: { username: "admin", password: ADMIN_PASSWORD },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 0,
      validateStatus: () => true,
    });
  } catch (err) {
    throw new Error(`Upload failed (${err.code || "network error"}). If the app refused the file as too large, raise SEARCH_INDEX_MAX_MB there.`);
  }
  if (res.status !== 200) {
    const why = res.data && res.data.error ? res.data.error : String(res.data || "").slice(0, 200);
    throw new Error(`The app answered ${res.status}: ${why}`);
  }
  console.log("The app is now using the new search file:", JSON.stringify(res.data));
}

async function main() {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
  // Prefer IPv4 for Google, as the server does (see server.js).
  require("node:dns").setDefaultResultOrder("ipv4first");
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.DRIVE_FOLDER_ID) throw new Error("DRIVE_FOLDER_ID is not set (.env)");
  const { crawlDrive } = require("../lib/drive-index.js");
  const { getDrive } = require("../lib/google.js");
  const { dataDir } = require("../lib/db.js");
  const { createPageIndex } = require("../lib/page-index.js");
  const { makeReadFile } = require("../lib/pdf-text.js");

  const dbFile = path.join(dataDir(), "search.db");
  console.log(`Search file: ${dbFile}`);
  const started = Date.now();

  const { files } = await crawlDrive({ getDrive, folderId: process.env.DRIVE_FOLDER_ID });
  let pdfs = files.filter((f) => f.mimeType === "application/pdf");
  console.log(`Drive: ${files.length} files, ${pdfs.length} are PDFs`);
  if (opts.limit) {
    pdfs = pdfs.slice(0, opts.limit);
    console.log(`--limit ${opts.limit}: only the first ${pdfs.length} PDFs`);
    if (opts.limitImpliedNoUpload) console.log("--limit builds a partial file, so it implies --no-upload: nothing will be uploaded.");
  }

  const index = createPageIndex({
    path: dbFile,
    maxBytes: Infinity,
    readFile: makeReadFile({ memoryMb: WORKER_MEMORY_MB, maxBytes: Infinity }),
  });
  index.sync(pdfs, { prune: !opts.limit, retryFailed: opts.retryFailed });

  const before = index.status();
  const todo = before.total - before.indexed - before.noText - before.tooLarge - before.failed;
  console.log(`${before.total} PDFs recorded, ${todo} to read`);
  let done = 0;
  while (await index.runNext()) {
    done += 1;
    if (done % 10 === 0 || done === todo) {
      const s = index.status();
      console.log(`  read ${done}/${todo}  (indexed ${s.indexed}, no text ${s.noText}, failed ${s.failed})`);
    }
  }

  index.compact();
  const status = index.status();
  const failures = index.failures();
  index.close();
  const mb = fs.statSync(dbFile).size / 1048576;
  console.log(`Finished in ${Math.round((Date.now() - started) / 1000)} s. search.db is ${mb.toFixed(1)} MB.`);
  console.log("status:", JSON.stringify(status));
  for (const f of failures) console.log(`  failed ${f.id}: ${f.error}`);

  if (opts.upload) await upload(dbFile);
  else console.log("--no-upload: not uploaded.");
}

module.exports = { parseArgs };

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => { console.error("build-index stopped:", err.message); process.exit(1); }
  );
}
