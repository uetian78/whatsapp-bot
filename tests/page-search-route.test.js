// "find ..." / "search ..." and the not-found paths, end to end through the
// replay harness (private fixtures, skipped when they are not on this machine).
// A real search.db is built in a temp DATA_DIR from fake page text; the AI is a
// fake client, so nothing here reaches the network or spends anything.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHarness, fixturesExist, readFixture } = require("./replay/harness.js");
const { createPageIndex, openSearchDb } = require("../lib/page-index.js");

const skip = !fixturesExist() && "replay fixtures not found (run tests/replay/export-log.js)";
const USER = "100000001";
const MB = 1024 * 1024;

const filler = (n) => Array.from({ length: n }, (_, i) => `general notes for section number ${i + 1} of this document`);

// Build DATA_DIR/search.db: files is [{ id, name, folder, pages: [text] }].
async function buildIndex(dir, files) {
  const pagesById = Object.fromEntries(files.map((f) => [f.id, f.pages]));
  const db = openSearchDb(path.join(dir, "search.db"));
  const index = createPageIndex({
    db, maxBytes: 10 * MB,
    readFile: async (f) => pagesById[f.id],
  });
  index.sync(files.map((f) => ({ id: f.id, name: f.name, folder: f.folder, mimeType: "application/pdf", size: 1000, md5: `md5-${f.id}` })));
  while (await index.runNext());
  index.compact();
  db.close(); // an injected handle stays open until the test closes it
}

const reply = (content) => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: "end_turn", content,
  usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
const cited = (text, document_index) => ({
  type: "text", text,
  citations: [{ type: "char_location", cited_text: "x", document_index, document_title: "t", start_char_index: 0, end_char_index: 1 }],
});

// Runs `body({ h, calls })` with a temp DATA_DIR holding `files` as the search
// index (none: no index file). `respond(params)` makes AI available, answering
// with its return value; leave it out and the bot has no AI key.
function scenario({ files = null, respond = null, spyPageHits = false }, body) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvac-page-route-"));
    const saved = { DATA_DIR: process.env.DATA_DIR, AI_MONTHLY_CAP_USD: process.env.AI_MONTHLY_CAP_USD };
    const sdkId = require.resolve("@anthropic-ai/sdk");
    const realSdk = require.cache[sdkId];
    const calls = [];
    const pageCalls = []; // what the channel was asked to show as page results
    process.env.DATA_DIR = dir;
    process.env.AI_MONTHLY_CAP_USD = "10";
    if (files) await buildIndex(dir, files);
    const h = createHarness(async (value, message) => {
      const { deliverMessage } = require("../server.js");
      const { whatsappAdapter } = require("../lib/channel-whatsapp.js");
      const channel = !spyPageHits ? whatsappAdapter : {
        ...whatsappAdapter,
        pageHits: async (to, prompt, hits) => { pageCalls.push({ prompt, hits }); return whatsappAdapter.pageHits(to, prompt, hits); },
      };
      await deliverMessage(value, message, channel);
    });
    if (respond) {
      function FakeAnthropic() {
        this.messages = { create: async (p) => { calls.push(p); return respond(p, calls.length); } };
      }
      process.env.ANTHROPIC_API_KEY = "test-key"; // createHarness blanked it; server.js reads it on first require
      require.cache[sdkId] = Object.assign(new (require("module"))(sdkId), { filename: sdkId, loaded: true, exports: FakeAnthropic });
    }
    try {
      await body({ h, calls, dir, pageCalls });
    } finally {
      try { require("../lib/db.js").closeDb(); } catch (_) { /* never opened */ }
      try { require("../lib/page-index.js").getPageIndex().close(); } catch (_) { /* never opened */ } // Windows keeps an open file locked
      if (realSdk) require.cache[sdkId] = realSdk; else delete require.cache[sdkId];
      h.close();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const allText = (out) => out.map((o) => o.text || "").join("\n");
const SOUND = { id: "apmr", name: "APMR-A Catalogue.pdf", folder: "Catalogues", pages: [...filler(13), "The sound level of the unit is 82 dB(A) measured at one metre."] };
const TRANE = { id: "trane", name: "Trane Product Notes.pdf", folder: "Misc", pages: ["Country of origin: the Trane unit is manufactured in the United States of America."] };
const NOT_ABOUT_MONEY = /credit|plan\b|paused|FREE|PAID/i;

test("find sound level returns page results", { skip }, scenario({ files: [SOUND] }, async ({ h }) => {
  const out = await h.send(USER, "find sound level");
  const text = allText(out);
  assert.match(text, /APMR-A Catalogue, page 14/);
  assert.match(text, /82 dB/);
  assert.ok(out.every((o) => o.kind !== "file"), "page results are text, no file is sent");
  assert.doesNotMatch(text, NOT_ABOUT_MONEY);
  assert.equal(h.stats.errors, 0, [...h.stats.errorSamples].join("; "));
}));

test("search works like find, and the words after the verb are what is searched", { skip }, scenario({ files: [TRANE] }, async ({ h }) => {
  const out = await h.send(USER, "Search Trane country of origin");
  assert.match(allText(out), /Trane Product Notes, page 1/);
}));

test("search all still means the existing command", { skip }, scenario({ files: [SOUND] }, async ({ h }) => {
  let out = await h.send(USER, "search all");
  assert.match(allText(out), /Tell me what to look for first/);
  assert.doesNotMatch(allText(out), /page \d+/);
  await h.send(USER, "find sound level");
  out = await h.send(USER, "search all");
  assert.match(allText(out), /sound level/); // it re-ran the find's words over the file names
  assert.doesNotMatch(allText(out), /, page \d+/);
}));

test("a file-name hit is sent as before, without page results", { skip }, scenario({}, async ({ h, dir }) => {
  const drive = readFixture("drive.local.json");
  const pick = drive.find((f) => /^[A-Za-z0-9 -]{6,30}\.pdf$/.test(f.name));
  assert.ok(pick, "the fixtures hold a simply named PDF");
  const query = pick.name.replace(/\.pdf$/i, "");
  // its words are on a page too: the name hit must still win and show no pages
  await buildIndex(dir, [{ id: "y", name: "Elsewhere.pdf", folder: "Misc", pages: [`this page mentions ${query} in passing`] }]);
  const out = await h.send(USER, `find ${query}`);
  assert.ok(out.some((o) => o.kind === "file" || o.kind === "buttons" || o.kind === "list"), "file(s) offered");
  assert.doesNotMatch(allText(out), /, page \d+/);
}));

test("when file names miss, page results come first, then close file names", { skip }, scenario({
  files: [{ id: "g", name: "Glorp Notes.pdf", folder: "Misc", pages: ["zzglorp quality special note about the unit"] }],
}, async ({ h }) => {
  const out = await h.send(USER, "find zzglorp quality");
  const i = out.findIndex((o) => /Glorp Notes, page 1/.test(o.text || ""));
  const j = out.findIndex((o) => ["file", "buttons", "list"].includes(o.kind));
  assert.ok(i >= 0, "page results are sent");
  assert.ok(j > i, "close file names come after the page results");
  assert.doesNotMatch(allText(out), NOT_ABOUT_MONEY);
}));

test("with no search index, find behaves like today's not-found path", { skip }, scenario({}, async ({ h }) => {
  const found = await h.send(USER, "find qzxwvk");
  const bare = await h.send(USER, "qzxwvk");
  assert.deepEqual(found, bare);
  assert.equal(h.stats.errors, 0, [...h.stats.errorSamples].join("; "));
}));

test("find and search on their own do not error", { skip }, scenario({ files: [SOUND] }, async ({ h }) => {
  for (const t of ["find", "search", "Search ", "find the"]) {
    const out = await h.send(USER, t);
    assert.ok(out.length > 0, t);
    assert.doesNotMatch(allText(out), /something went wrong/i, t);
  }
  assert.equal(h.stats.errors, 0, [...h.stats.errorSamples].join("; "));
}));

test("the answer cites the pages it used, and is the only AI call", { skip }, scenario({
  files: [TRANE],
  respond: () => reply([cited("Trane units are made in the United States.", 0)]),
}, async ({ h, calls }) => {
  const out = await h.send(USER, "find Trane country of origin");
  const text = allText(out);
  assert.match(text, /Trane units are made in the United States\./);
  assert.match(text, /Trane Product Notes, page 1/);
  assert.equal(calls.length, 1, "one AI call");
  assert.equal(calls[0].model, "claude-haiku-5-5");
  assert.ok(calls[0].messages[0].content.some((b) => b.type === "document" && b.citations.enabled));
  assert.ok(out.every((o) => o.kind === "text"));
  assert.doesNotMatch(text, /Closest matches/);
}));

test("NO_ANSWER falls through to document search with no second AI call", { skip }, scenario({
  files: [SOUND],
  respond: () => reply([{ type: "text", text: "NO_ANSWER" }]),
}, async ({ h, calls }) => {
  const out = await h.send(USER, "find sound level");
  assert.match(allText(out), /APMR-A Catalogue, page 14/);
  assert.equal(calls.length, 1, "the related-files and guidance steps are skipped when pages were found");
}));

test("an AI error still shows the page results", { skip }, scenario({
  files: [SOUND],
  respond: () => { throw new Error("boom"); },
}, async ({ h, calls }) => {
  const out = await h.send(USER, "find sound level");
  assert.match(allText(out), /APMR-A Catalogue, page 14/);
  assert.doesNotMatch(allText(out), NOT_ABOUT_MONEY);
  assert.equal(calls.length, 1);
}));

test("with AI unavailable, the person still gets the page results", { skip }, scenario({ files: [SOUND] }, async ({ h }) => {
  const out = await h.send(USER, "find sound level");
  assert.match(allText(out), /page 14/);
  assert.doesNotMatch(allText(out), NOT_ABOUT_MONEY);
}));

test("a find with no matching pages keeps today's AI search, and spends at most two calls", { skip }, scenario({
  files: [SOUND],
  respond: (p) => reply([{ type: "text", text: String(p.system).includes("did NOT match") ? "SHOW_MENU" : "0" }]),
}, async ({ h, calls }) => {
  const out = await h.send(USER, "find qzxwvk");
  assert.match(allText(out), /Even AI couldn't find anything matching "qzxwvk"/);
  assert.ok(calls.length <= 2, `${calls.length} calls`);
  assert.ok(calls.every((c) => !JSON.stringify(c.system).includes("NO_ANSWER")), "no library answer call without pages");
}));

test("a not-found lookup that matches pages shows them, and never guesses from the page words alone", { skip }, scenario({
  files: [{ id: "z", name: "Zeta Notes.pdf", folder: "Misc", pages: ["the t1 rating is shown for this unit on this page"] }],
}, async ({ h }) => {
  // "apmr52090 t1" names a model code with no file: it used to end in the not-found reply.
  const out = await h.send(USER, "apmr52090 t1");
  assert.doesNotMatch(allText(out), /Zeta Notes/, "one matching word is not enough on a not-found path");
}));

test("a series word plus extras that match no file name looks in the pages before the menu", { skip }, scenario({
  files: [{ id: "q", name: "Coil Guide.pdf", folder: "Misc", pages: ["fcu zzglorp coil connection details are on this page"] }],
}, async ({ h }) => {
  require("../lib/drive-index.js").listFolderFiles = async () => []; // no file name can match
  const out = await h.send(USER, "fcu zzglorp");
  assert.match(allText(out), /Coil Guide, page 1/);
}));

test("admin stats adds one line about the PDF search", { skip }, scenario({ files: [SOUND] }, async ({ h }) => {
  const out = await h.send(USER, "stats");
  assert.match(allText(out), /🔎 PDF search: 1 files read, 14 pages/);
}));

test("admin stats has no PDF line while there is no index", { skip }, scenario({}, async ({ h }) => {
  const out = await h.send(USER, "stats");
  assert.doesNotMatch(allText(out), /PDF search/);
  assert.match(allText(out), /\[stats\]/);
}));

// ── "find ..." in front of a request the engines or the series router handle ──
// The verb must change nothing: the same words with it give the same replies as
// without it (the files delivered, the selection, the menu), even when the page
// index holds pages that mention those words.
const ENGINE_WORDS = [
  "apmr-a catalogue",
  "apmr-a 51008 datasheet t3",
  "apcy-e 100 tr",
  "me the apmr iom",
  "me an apmr",
];
for (const words of ENGINE_WORDS) {
  for (const verb of ["find", "search"]) {
    const asked = words.replace(/^me (the|an) /, "");
    test(`"${verb} ${words}" gives the same replies as "${asked}"`, { skip }, scenario({ files: [SOUND, TRANE] }, async ({ h }) => {
      const bare = await h.send(USER, asked);
      const withVerb = await h.send(USER, `${verb} ${words}`);
      assert.ok(bare.length > 0);
      assert.deepEqual(withVerb, bare);
      assert.doesNotMatch(allText(withVerb), /, page \d+|Closest matches for "me /);
    }));
  }
}

test("find apmr-a catalogue delivers the same file as apmr-a catalogue, not a looser name match", { skip }, scenario({}, async ({ h }) => {
  const bare = (await h.send(USER, "apmr-a catalogue")).filter((o) => o.kind === "file").map((o) => o.file);
  const found = (await h.send(USER, "find apmr-a catalogue")).filter((o) => o.kind === "file").map((o) => o.file);
  assert.ok(bare.length > 0, "the baseline delivers a file");
  assert.deepEqual(found, bare);
}));

test("find with no pages and no index goes the way the same words go without it", { skip }, scenario({}, async ({ h }) => {
  for (const words of ["sound level", "what is the capacity of apmr 52340?"]) {
    const bare = await h.send(USER, words);
    assert.deepEqual(await h.send(USER, `find ${words}`), bare, words);
  }
}));

test("search all <words> is a search over every file name, not a page search", { skip }, scenario({
  files: [{ id: "t", name: "Notes.pdf", folder: "Misc", pages: ["all trane units listed here carry the same plate on this page"] }],
}, async ({ h }) => {
  for (const t of ["search all manuals", "search all trane"]) {
    const out = await h.send(USER, t);
    assert.ok(out.length > 0, t);
    assert.doesNotMatch(allText(out), /, page \d+|Pages in the PDFs/, t);
    assert.match(allText(out), /Searching every file for "(manuals|trane)"/, t);
  }
}));

test("after an AI answer the cited pages follow as page results, each a full hit, and the text version for WhatsApp copes", { skip }, scenario({
  files: [TRANE],
  respond: () => reply([cited("Trane units are made in the United States.", 0)]),
  spyPageHits: true,
}, async ({ h, calls, pageCalls }) => {
  const out = await h.send(USER, "find Trane country of origin");
  const text = allText(out);
  const answerAt = out.findIndex((o) => /Trane units are made in the United States\./.test(o.text || ""));
  const pagesAt = out.findIndex((o, i) => i > answerAt && /Pages used for this answer:/.test(o.text || ""));
  assert.ok(answerAt >= 0, "the answer is sent");
  assert.ok(pagesAt > answerAt, "the pages come after the answer");
  assert.match(out[pagesAt].text, /Trane Product Notes, page 1/);
  assert.equal(pageCalls.length, 1);
  assert.equal(pageCalls[0].prompt, "Pages used for this answer:");
  assert.equal(pageCalls[0].hits.length, 1);
  const hit = pageCalls[0].hits[0];
  assert.equal(hit.fileId, "trane");
  assert.equal(hit.page, 1);
  assert.equal(hit.name, "Trane Product Notes.pdf");
  assert.equal(hit.folder, "Misc");
  assert.match(hit.snippet, /United States/);
  assert.equal(hit.size, 1000);
  assert.equal(calls.length, 1, "still one AI call");
  assert.doesNotMatch(text, /something went wrong/i);
  assert.equal(h.stats.errors, 0, [...h.stats.errorSamples].join("; "));
}));

test("an answer that cites nothing sends no page results", { skip }, scenario({
  files: [TRANE],
  respond: () => reply([{ type: "text", text: "FROM_KB: Trane is a brand we sell." }]),
  spyPageHits: true,
}, async ({ h, pageCalls }) => {
  const out = await h.send(USER, "find Trane country of origin");
  assert.match(allText(out), /Trane is a brand we sell/);
  assert.equal(pageCalls.filter((c) => c.prompt === "Pages used for this answer:").length, 0);
}));
