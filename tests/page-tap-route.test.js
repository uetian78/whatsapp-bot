// The page|<fileId>|<n>|pdf|image taps, through the real server.js and the replay
// harness (private fixtures, skipped when they are not on this machine). The page
// extractor is replaced by a fake, so no tool runs and nothing reaches Drive.
const test = require("node:test");
require("./clean-env.js"); // a DATA_DIR left in the shell must not reach the harness
const assert = require("node:assert");
const { createHarness, fixturesExist } = require("./replay/harness.js");

const skip = !fixturesExist() && "replay fixtures not found (run tests/replay/export-log.js)";
const USER = "100000001";

// Sends `tapId` as a button tap from USER, with the extractor's getPage replaced by `getPage`.
async function tap(tapId, getPage) {
  const h = createHarness(async (value, message) => {
    message.type = "interactive";
    message.interactive = { type: "button_reply", button_reply: { id: tapId, title: "Page" } };
    const { deliverMessage } = require("../server.js");
    const { whatsappAdapter } = require("../lib/channel-whatsapp.js");
    await deliverMessage(value, message, whatsappAdapter);
  });
  try {
    const extractor = require("../lib/page-extract.js").getPageExtractor();
    extractor.getPage = getPage;
    const out = await h.send(USER, "tap");
    return { out, errors: [...h.stats.errorSamples] };
  } finally {
    try { require("../lib/db.js").closeDb(); } catch (_) { /* never opened */ }
    h.close();
  }
}

test("a page tap says it is working, then sends just that page", { skip }, async () => {
  const seen = [];
  const { out } = await tap("page|File_1-abc|14|pdf", async (req) => {
    seen.push(req);
    return { buffer: Buffer.from("%PDF-1.4"), filename: "APMR-A Catalogue - page 14.pdf" };
  });
  assert.deepEqual(seen, [{ fileId: "File_1-abc", page: "14", format: "pdf" }]);
  assert.equal(out[0].kind, "text");
  assert.match(out[0].text, /Getting that page/);
  assert.equal(out[1].kind, "file");
  assert.equal(out[1].file, "APMR-A Catalogue - page 14.pdf");
  assert.equal(out[1].text, "APMR-A Catalogue - page 14");
  assert.equal(out.length, 2);
});

test("an image tap asks for the image format", { skip }, async () => {
  const seen = [];
  const { out } = await tap("page|File_1-abc|3|image", async (req) => {
    seen.push(req);
    return { buffer: Buffer.from([0xff, 0xd8]), filename: "X - page 3.jpg" };
  });
  assert.equal(seen[0].format, "image");
  assert.equal(out[1].file, "X - page 3.jpg");
});

test("a refused page shows the extractor's own sentence", { skip }, async () => {
  const { out } = await tap("page|File_1-abc|99|pdf", async () => {
    // the harness reloads project modules, so take the class the server is using
    const { PageError } = require("../lib/page-extract.js");
    throw new PageError("That page isn't in this file.");
  });
  assert.match(out[0].text, /Getting that page/);
  assert.equal(out[out.length - 1].text, "That page isn't in this file.");
  assert.ok(out.every((o) => o.kind !== "file"));
});

test("any other failure gets the generic sentence and is logged, not shown", { skip }, async () => {
  const { out, errors } = await tap("page|File_1-abc|2|pdf", async () => { throw new Error("secret internal detail"); });
  assert.equal(out[out.length - 1].text, "Couldn't get that page. Open the full file instead.");
  assert.ok(!out.some((o) => /secret/.test(o.text || "")));
  assert.ok(errors.some((e) => /Page send error/.test(e)));
});

test("a malformed page tap never reaches the extractor", { skip }, async () => {
  let called = false;
  const { out } = await tap("page|../../etc|1|pdf", async () => { called = true; });
  assert.equal(called, false);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "That page isn't in this file.");
});
