const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { track } = require("./tmpdirs.js"); // temp folders are removed when the run ends

// Set before lib/google.js loads: it reads the key once, at require time.
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "t@example.test", private_key: privateKey });

const {
  createPageExtractor, getPageExtractor, defaultRun, PageError, pageTapId, parsePageTap,
} = require("../lib/page-extract.js");

const BAD_PAGE = "That page isn't in this file.";
const FAILED = "Couldn't get that page. Open the full file instead.";

const FILE = { id: "File_1-abc", name: "APMR-A Catalogue.pdf", folder: "Catalogue", mimeType: "application/pdf", size: 96_000_000, md5: "m1" };
const tmpEntries = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("hvac-pagecut-")).sort();
const leftovers = (before) => tmpEntries().filter((n) => !before.includes(n));

// A fake run: records every call, answers --show-npages, and writes the output
// file the real tool would write (the last argument; pdftoppm adds .jpg itself).
function fakeRun({ npages = 20, outBytes = 1000, delay = 0, fail = null } = {}) {
  const calls = [];
  let active = 0, maxActive = 0;
  async function run(cmd, args, opts) {
    calls.push({ cmd, args, opts });
    active += 1; maxActive = Math.max(maxActive, active);
    try {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (fail) return await fail(cmd, args);
      if (args[0] === "--show-npages") return { code: 0, stdout: `${npages}\n`, stderr: "" };
      const last = args[args.length - 1];
      await fsp.writeFile(cmd === "pdftoppm" ? `${last}.jpg` : last, Buffer.alloc(outBytes, 7));
      return { code: 0, stdout: "", stderr: "" };
    } finally { active -= 1; }
  }
  run.calls = calls;
  run.maxActive = () => maxActive;
  return run;
}

function fakeStream(chunks = [Buffer.from("%PDF-1.4 "), Buffer.from("rest")]) {
  const asked = [];
  const stream = async (id) => { asked.push(id); return Readable.from(chunks); };
  stream.asked = asked;
  return stream;
}

async function make(over = {}) {
  const dataDir = track(await fsp.mkdtemp(path.join(os.tmpdir(), "page-test-data-")));
  const run = over.run || fakeRun();
  const stream = over.stream || fakeStream();
  const library = over.library || { list: async () => [FILE], findById: (id) => (id === FILE.id ? FILE : null) };
  let t = 1_000_000;
  const ex = createPageExtractor({ run, stream, dataDir, now: () => (t += 1000), library, ...over.opts });
  return { ex, run, stream, dataDir };
}

test("the PDF job asks qpdf for one page", async () => {
  const { ex, run } = await make();
  await ex.getPage({ file: FILE, page: 14, format: "pdf" });
  const job = run.calls.find((c) => c.cmd === "qpdf" && c.args[0] === "--empty");
  const src = job.args[2];
  const out = job.args[5];
  assert.deepEqual(job.args, ["--empty", "--pages", src, "14", "--", out]);
  assert.ok(src.startsWith(os.tmpdir()), "source lives in the temp folder");
  assert.equal(path.dirname(src), path.dirname(out));
});

test("the image job asks pdftoppm for one page at 150 dpi", async () => {
  const { ex, run } = await make();
  const r = await ex.getPage({ file: FILE, page: 14, format: "image" });
  const job = run.calls.find((c) => c.cmd === "pdftoppm");
  const src = job.args[job.args.length - 2];
  const outBase = job.args[job.args.length - 1];
  assert.deepEqual(job.args, ["-f", "14", "-l", "14", "-singlefile", "-r", "150", "-jpeg", src, outBase]);
  assert.equal(r.buffer.length, 1000);
});

test("the file name is <file name> - page 14.pdf, or .jpg for an image", async () => {
  const { ex } = await make();
  assert.equal((await ex.getPage({ file: FILE, page: 14, format: "pdf" })).filename, "APMR-A Catalogue - page 14.pdf");
  assert.equal((await ex.getPage({ file: FILE, page: 14, format: "image" })).filename, "APMR-A Catalogue - page 14.jpg");
  const odd = { ...FILE, id: "odd1", name: 'A/B:C?"D.PDF' };
  assert.equal((await ex.getPage({ file: odd, page: 2, format: "pdf" })).filename, "A_B_C__D - page 2.pdf");
});

test("a page outside the file gets: That page isn't in this file.", async () => {
  const before = tmpEntries();
  const { ex, run } = await make({ run: fakeRun({ npages: 5 }) });
  await assert.rejects(ex.getPage({ file: FILE, page: 14, format: "pdf" }), (e) => e instanceof PageError && e.userMessage === BAD_PAGE);
  assert.ok(!run.calls.some((c) => c.args[0] === "--empty"), "no page job after the page count said no");
  assert.deepEqual(leftovers(before), []);
});

test("bad page numbers are refused before anything is downloaded", async () => {
  const { ex, run, stream } = await make();
  for (const bad of [0, -1, 1.5, "1e3", 1e21, "abc", "", null, undefined, "14 ", "0x10", "999999999", NaN, "../1"]) {
    await assert.rejects(ex.getPage({ file: FILE, page: bad, format: "pdf" }), (e) => e.userMessage === BAD_PAGE, String(bad));
  }
  assert.equal(run.calls.length, 0);
  assert.equal(stream.asked.length, 0);
});

test("a file id not in the library is refused", async () => {
  let listed = 0;
  const library = { list: async () => { listed += 1; }, findById: () => null };
  const { ex, run, stream } = await make({ library });
  await assert.rejects(ex.getPage({ fileId: "nope", page: 3, format: "pdf" }), (e) => e instanceof PageError && /library/i.test(e.userMessage));
  assert.equal(listed, 1, "the library list is awaited once before refusing");
  await assert.rejects(ex.getPage({ fileId: "../../etc/passwd", page: 3, format: "pdf" }), (e) => e instanceof PageError);
  assert.equal(run.calls.length, 0);
  assert.equal(stream.asked.length, 0);
});

test("a file id is found once the library list has been read", async () => {
  let ready = false;
  const library = { list: async () => { ready = true; }, findById: (id) => (ready && id === FILE.id ? FILE : null) };
  const { ex } = await make({ library });
  const r = await ex.getPage({ fileId: FILE.id, page: 3, format: "pdf" });
  assert.equal(r.filename, "APMR-A Catalogue - page 3.pdf");
});

test("Google-native and non-PDF files are refused", async () => {
  const { ex, stream } = await make();
  const doc = { ...FILE, id: "doc1", name: "Notes", mimeType: "application/vnd.google-apps.document", exportMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  const xls = { ...FILE, id: "xls1", name: "Sizes.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  for (const f of [doc, xls]) {
    await assert.rejects(ex.getPage({ file: f, page: 1, format: "pdf" }), (e) => e instanceof PageError && /PDF/.test(e.userMessage));
  }
  assert.equal(stream.asked.length, 0);
});

test("the same page of the same file version comes from the cache with no download", async () => {
  const { ex, run, stream } = await make();
  const a = await ex.getPage({ file: FILE, page: 14, format: "pdf" });
  const callsAfterFirst = run.calls.length;
  const b = await ex.getPage({ file: FILE, page: 14, format: "pdf" });
  assert.equal(stream.asked.length, 1);
  assert.equal(run.calls.length, callsAfterFirst, "no tool ran for the cached page");
  assert.deepEqual(b, a);
  // another format or page is a different entry
  await ex.getPage({ file: FILE, page: 14, format: "image" });
  await ex.getPage({ file: FILE, page: 15, format: "pdf" });
  assert.equal(stream.asked.length, 3);
});

test("a changed md5 gets a fresh page", async () => {
  const { ex, stream } = await make();
  await ex.getPage({ file: FILE, page: 14, format: "pdf" });
  await ex.getPage({ file: { ...FILE, md5: "m2" }, page: 14, format: "pdf" });
  assert.equal(stream.asked.length, 2);
});

test("the cache is DATA_DIR/page-cache, made on first use, hashed names, capped oldest first", async () => {
  const s = fakeStream();
  const { ex, dataDir } = await make({ stream: s, opts: { cacheMb: 2500 / 1048576 } });
  const dir = path.join(dataDir, "page-cache");
  assert.ok(!fs.existsSync(dir), "no folder before first use");
  for (const p of [1, 2, 3]) await ex.getPage({ file: FILE, page: p, format: "pdf" });
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 2, "1000-byte pages under a 2500-byte cap keep two");
  assert.ok(files.every((n) => /^[0-9a-f]+\.pdf$/.test(n)), "cache names are hashes, not user input");
  assert.equal(s.asked.length, 3);
  await ex.getPage({ file: FILE, page: 3, format: "pdf" });
  await ex.getPage({ file: FILE, page: 2, format: "pdf" });
  assert.equal(s.asked.length, 3, "pages 2 and 3 are still cached");
  await ex.getPage({ file: FILE, page: 1, format: "pdf" });
  assert.equal(s.asked.length, 4, "page 1, the oldest, was removed first");
});

test("PAGE_CACHE_MB sets the cap and a bad value falls back to 100", () => {
  const keep = process.env.PAGE_CACHE_MB;
  const mb = () => createPageExtractor({ run: fakeRun(), stream: fakeStream(), dataDir: os.tmpdir() }).cacheMb;
  try {
    process.env.PAGE_CACHE_MB = "7";
    assert.equal(mb(), 7);
    process.env.PAGE_CACHE_MB = "lots";
    assert.equal(mb(), 100);
    process.env.PAGE_CACHE_MB = "-5";
    assert.equal(mb(), 100);
    delete process.env.PAGE_CACHE_MB;
    assert.equal(mb(), 100);
  } finally {
    if (keep === undefined) delete process.env.PAGE_CACHE_MB; else process.env.PAGE_CACHE_MB = keep;
  }
});

test("only one page job runs at a time", async () => {
  const run = fakeRun({ delay: 20 });
  const { ex } = await make({ run });
  const results = await Promise.all([1, 2, 3, 4].map((p) => ex.getPage({ file: FILE, page: p, format: "pdf" })));
  assert.equal(results.length, 4);
  assert.equal(run.maxActive(), 1);
});

test("a queued job still runs after the one ahead of it failed", async () => {
  let first = true;
  const run = fakeRun({
    fail: async (cmd, args) => {
      if (args[0] === "--empty" && first) { first = false; return { code: 2, stdout: "", stderr: "boom" }; }
      if (args[0] === "--show-npages") return { code: 0, stdout: "20\n", stderr: "" };
      const last = args[args.length - 1];
      await fsp.writeFile(last, Buffer.alloc(10));
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const { ex } = await make({ run });
  const [a, b] = await Promise.allSettled([
    ex.getPage({ file: FILE, page: 1, format: "pdf" }),
    ex.getPage({ file: FILE, page: 2, format: "pdf" }),
  ]);
  assert.equal(a.status, "rejected");
  assert.equal(b.status, "fulfilled");
});

test("a failed or timed-out job gets: Couldn't get that page. Open the full file instead. and temp files are removed", async () => {
  const before = tmpEntries();
  const cases = {
    "tool exits non-zero": () => ({ code: 2, stdout: "", stderr: "qpdf: damaged" }),
    "tool timed out": () => ({ code: null, stdout: "", stderr: "", timedOut: true }),
    "tool is missing": () => ({ code: -1, stdout: "", stderr: "", error: "ENOENT" }),
    "run throws": () => { throw new Error("spawn exploded"); },
  };
  for (const [label, fail] of Object.entries(cases)) {
    const { ex } = await make({ run: fakeRun({ fail }) });
    await assert.rejects(ex.getPage({ file: FILE, page: 4, format: "pdf" }), (e) => e instanceof PageError && e.userMessage === FAILED, label);
  }
  // the count worked, the page job itself failed
  const { ex } = await make({
    run: fakeRun({ fail: (cmd, args) => (args[0] === "--show-npages" ? { code: 0, stdout: "9\n", stderr: "" } : { code: 1, stdout: "", stderr: "x" }) }),
  });
  await assert.rejects(ex.getPage({ file: FILE, page: 4, format: "image" }), (e) => e.userMessage === FAILED);
  assert.deepEqual(leftovers(before), []);
});

test("an unreadable page count is a failure, not a missing page", async () => {
  const { ex } = await make({ run: fakeRun({ fail: () => ({ code: 0, stdout: "not a number", stderr: "" }) }) });
  await assert.rejects(ex.getPage({ file: FILE, page: 4, format: "pdf" }), (e) => e.userMessage === FAILED);
});

test("a tool that wrote nothing is a failure", async () => {
  const { ex } = await make({ run: fakeRun({ fail: (cmd, args) => ({ code: 0, stdout: args[0] === "--show-npages" ? "9\n" : "", stderr: "" }) }) });
  await assert.rejects(ex.getPage({ file: FILE, page: 4, format: "pdf" }), (e) => e.userMessage === FAILED);
});

test("qpdf exit 3 (warnings) still counts when the page was written", async () => {
  const real = fakeRun();
  const warn = async (cmd, args, o) => {
    const r = await real(cmd, args, o);
    return args[0] === "--empty" ? { ...r, code: 3, stderr: "warning: recovered" } : r;
  };
  const { ex } = await make({ run: warn });
  const r = await ex.getPage({ file: FILE, page: 4, format: "pdf" });
  assert.equal(r.buffer.length, 1000);
});

test("a stream error or a stalled download fails cleanly and removes the partial file", async () => {
  const before = tmpEntries();
  const broken = async () => new Readable({
    read() { this.push(Buffer.from("%PDF-part")); setImmediate(() => this.destroy(new Error("socket hang up"))); },
  });
  const a = await make({ stream: broken });
  await assert.rejects(a.ex.getPage({ file: FILE, page: 4, format: "pdf" }), (e) => e.userMessage === FAILED);
  assert.equal(a.run.calls.length, 0, "no tool runs on a partial file");

  const stalled = async () => new Readable({ read() {} });
  const b = await make({ stream: stalled, opts: { downloadTimeoutMs: 60 } });
  await assert.rejects(b.ex.getPage({ file: FILE, page: 4, format: "pdf" }), (e) => e.userMessage === FAILED);
  assert.equal(b.run.calls.length, 0);

  const never = () => new Promise(() => {});
  const c = await make({ stream: never, opts: { downloadTimeoutMs: 60 } });
  await assert.rejects(c.ex.getPage({ file: FILE, page: 4, format: "pdf" }), (e) => e.userMessage === FAILED);

  const refused = async () => { throw new Error("403"); };
  const d = await make({ stream: refused });
  await assert.rejects(d.ex.getPage({ file: FILE, page: 4, format: "pdf" }), (e) => e.userMessage === FAILED);
  assert.deepEqual(leftovers(before), []);
});

test("the download goes to a temp file through a stream, never one big Buffer", async () => {
  const chunks = [Buffer.alloc(300_000, 1), Buffer.alloc(300_000, 2), Buffer.alloc(100, 3)];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  let handedBack;
  const stream = async () => (handedBack = Readable.from(chunks));
  const sizes = [];
  const real = fakeRun();
  const run = async (cmd, args, o) => {
    const src = args.find((a) => /source\.pdf$/.test(a));
    if (src) sizes.push(fs.statSync(src).size);
    return real(cmd, args, o);
  };
  const { ex } = await make({ run, stream });
  await ex.getPage({ file: FILE, page: 2, format: "pdf" });
  assert.ok(handedBack instanceof Readable && !Buffer.isBuffer(handedBack));
  assert.ok(sizes.length >= 2 && sizes.every((s) => s === total), "tools saw the whole file on disk");
});

test("tools run with a 60 second limit by default", async () => {
  const { ex, run } = await make();
  await ex.getPage({ file: FILE, page: 2, format: "pdf" });
  assert.ok(run.calls.length >= 2);
  assert.ok(run.calls.every((c) => c.opts && c.opts.timeoutMs === 60_000));
});

test("tap ids round-trip and reject anything else", () => {
  assert.equal(pageTapId("File_1-abc", 14, "pdf"), "page|File_1-abc|14|pdf");
  assert.deepEqual(parsePageTap("page|File_1-abc|14|image"), { fileId: "File_1-abc", page: "14", format: "image" });
  for (const bad of ["page|x|14", "page|x|14|gif", "page||14|pdf", "page|a b|1|pdf", "page|../x|1|pdf", "page|x|1|pdf|extra", "menu|1", null, 7]) {
    assert.equal(parsePageTap(bad), null, String(bad));
  }
});

test("getPageExtractor is a lazy shared instance", () => {
  const a = getPageExtractor();
  assert.equal(a, getPageExtractor());
  assert.equal(typeof a.getPage, "function");
});

test("the default run uses no shell, caps captured output and kills on timeout", async () => {
  const echo = await defaultRun(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "a && b | c"], { timeoutMs: 10_000 });
  assert.equal(echo.code, 0);
  assert.equal(echo.stdout, "a && b | c", "args reach the program untouched");

  const big = await defaultRun(process.execPath, ["-e", "process.stdout.write('x'.repeat(2e6)); process.stderr.write('e'.repeat(2e6))"], { timeoutMs: 20_000 });
  assert.equal(big.code, 0);
  assert.ok(big.stdout.length <= 1000 && big.stderr.length <= 1000);

  const t0 = Date.now();
  const slow = await defaultRun(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - t0 < 10_000);

  const missing = await defaultRun("definitely-not-a-real-tool-xyz", [], { timeoutMs: 5000 });
  assert.equal(missing.code, -1);
  assert.ok(missing.error);
});

test("streamDriveFile asks Drive for the bytes as a stream with the service-account token", async () => {
  const axios = require("axios");
  const google = require("../lib/google.js");
  const realGet = axios.get, realPost = axios.post;
  const body = Readable.from([Buffer.from("x")]);
  let seen;
  axios.post = async () => ({ data: { access_token: "tok-test", expires_in: 3600 } });
  axios.get = async (url, opts) => { seen = { url, opts }; return { data: body }; };
  const log = console.log; console.log = () => {};
  try {
    const got = await google.streamDriveFile("File_1-abc");
    assert.equal(got, body);
    assert.equal(seen.url, "https://www.googleapis.com/drive/v3/files/File_1-abc?alt=media&supportsAllDrives=true");
    assert.equal(seen.opts.responseType, "stream");
    assert.equal(seen.opts.headers.Authorization, "Bearer tok-test");

    // an error response's body is a stream too: it must be closed, not left open
    const errBody = Readable.from([Buffer.from("nope")]);
    axios.get = async () => { const e = new Error("404"); e.response = { status: 404, data: errBody }; throw e; };
    await assert.rejects(google.streamDriveFile("File_1-abc"), /404/);
    assert.equal(errBody.destroyed, true);
  } finally {
    console.log = log; axios.get = realGet; axios.post = realPost;
  }
});

const toolsInstalled = ["qpdf", "pdftoppm"].every((t) => !spawnSync(t, ["--version"], { stdio: "ignore" }).error);

test("real tools make a one-page PDF and a JPEG", { skip: !toolsInstalled }, async () => {
  const PDFDocument = require("pdfkit");
  const src = path.join(track(await fsp.mkdtemp(path.join(os.tmpdir(), "page-test-src-"))), "three.pdf");
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const out = fs.createWriteStream(src);
    out.on("finish", resolve); out.on("error", reject);
    doc.pipe(out);
    doc.text("page one"); doc.addPage().text("page two"); doc.addPage().text("page three");
    doc.end();
  });
  const { ex } = await make({ run: defaultRun, stream: async () => fs.createReadStream(src) });
  const file = { ...FILE, id: "real1" };
  const pdf = await ex.getPage({ file, page: 2, format: "pdf" });
  assert.equal(pdf.buffer.subarray(0, 4).toString(), "%PDF");
  const one = path.join(path.dirname(src), "one.pdf");
  await fsp.writeFile(one, pdf.buffer);
  const count = spawnSync("qpdf", ["--show-npages", one]);
  assert.equal(String(count.stdout).trim(), "1");
  const img = await ex.getPage({ file, page: 3, format: "image" });
  assert.deepEqual([...img.buffer.subarray(0, 2)], [0xff, 0xd8]);
  await assert.rejects(ex.getPage({ file, page: 4, format: "pdf" }), (e) => e.userMessage === BAD_PAGE);
});
