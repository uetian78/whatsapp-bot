// Replays the real message log through server.js and checks the bot still does
// exactly what it did when the baseline was captured. Skipped when the private
// fixtures are not on this machine (they are gitignored: tests/replay/*.local.json).
// Create them with export-log.js, then capture-baseline.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { replayAll, fixturesExist, fixturePath, readFixture } = require("./harness.js");

const fixturesReady = fixturesExist() && fs.existsSync(fixturePath("baseline.local.json"));
const skip = !fixturesReady && "replay fixtures not found (run export-log.js and capture-baseline.js)";

test("baseline covers every message in the exported log", { skip }, () => {
  const messages = readFixture("messages.local.json");
  const baseline = readFixture("baseline.local.json");
  assert.equal(baseline.length, messages.length);
  console.log(`# replay baseline covers ${baseline.length} messages`);
});

test("replay matches baseline", { skip }, async () => {
  const info = {};
  const replayed = await replayAll({ info });
  assert.deepEqual(info.networkBlocked, [], "the replay must not reach the network");
  assert.deepEqual(replayed, readFixture("baseline.local.json"));
});

test("a second replay in the same process matches the first", { skip }, async () => {
  assert.deepEqual(await replayAll(), await replayAll());
});
