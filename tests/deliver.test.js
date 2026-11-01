// deliverMessage (server.js): who is allowed, the reply, and saving state after.
// Runs through the replay harness (private fixtures, gitignored), skipped when
// they are not on this machine. State goes to a temp DATA_DIR, never the home folder.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHarness, fixturesExist } = require("./replay/harness.js");

const skip = !fixturesExist() && "replay fixtures not found (run tests/replay/export-log.js)";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvac-deliver-"));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const h = createHarness(async (value, message) => {
    const { deliverMessage } = require("../server.js");
    const { whatsappAdapter } = require("../lib/channel-whatsapp.js");
    await deliverMessage(value, message, whatsappAdapter);
  });
  // The harness reloads project modules, so take the database from the same copy the server uses.
  const db = () => require("../lib/db.js");
  return {
    h, db,
    rows: (user) => db().getDb().prepare("SELECT key FROM user_state WHERE user = ?").all(user).map((r) => r.key),
    done() {
      try { db().closeDb(); } catch (_) { /* never opened */ }
      h.close();
      if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("an allowed user's reply is sent and their state is saved", { skip }, async () => {
  const t = setup();
  try {
    const out = await t.h.send("100000001", "hi");
    assert.ok(out.length > 0);
    assert.ok(t.rows("100000001").length > 0);
  } finally { t.done(); }
});

test("a sender who is not allowed gets no reply and nothing is saved", { skip }, async () => {
  const t = setup();
  try {
    const out = await t.h.send("199999999", "hi");
    assert.deepEqual(out, []);
    assert.deepEqual(t.rows("199999999"), []);
  } finally { t.done(); }
});

test("a failed save is logged and the reply still goes out", { skip }, async () => {
  const t = setup();
  try {
    await t.h.send("100000001", "hi"); // opens the database
    t.db().getDb().exec("DROP TABLE user_state"); // the next save will fail
    const out = await t.h.send("100000001", "menu");
    assert.ok(out.length > 0);
    assert.ok(t.h.stats.errorSamples.has("State save failed:"));
  } finally { t.done(); }
});
