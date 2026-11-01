// Records what the bot does today for every logged message.
//
//   node tests/replay/capture-baseline.js
//
// Writes baseline.local.json (the current reference; recapture it after a
// reviewed change) and, only if it doesn't exist yet, baseline.original.local.json
// (the first one, kept for good so `diff.js baseline.original.local.json` always
// measures against today's behavior).
const fs = require("fs");
const { replayAll, fixturesExist, fixturePath, readFixture } = require("./harness.js");

async function main() {
  if (!fixturesExist()) throw new Error("fixtures missing: run node tests/replay/export-log.js first");
  const messages = readFixture("messages.local.json");
  const info = {};
  const started = performance.now();
  const baseline = await replayAll({ info });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);

  if (baseline.length !== messages.length) {
    throw new Error(`baseline covers ${baseline.length} of ${messages.length} logged messages`);
  }
  if (info.networkBlocked.length) {
    throw new Error(`the replay tried ${info.networkBlocked.length} network call(s), e.g. ${info.networkBlocked[0]}`);
  }

  const json = JSON.stringify(baseline);
  fs.writeFileSync(fixturePath("baseline.local.json"), json);
  const first = !fs.existsSync(fixturePath("baseline.original.local.json"));
  if (first) fs.writeFileSync(fixturePath("baseline.original.local.json"), json);

  const files = baseline.reduce((n, e) => n + e.outbound.filter((o) => o.kind === "file").length, 0);
  console.log(
    `Baseline covers all ${baseline.length} logged messages (${messages.length} in the exported log); ` +
    `${info.stale} stale taps, ${files} files delivered, ${seconds}s.` +
    (first ? " Also saved baseline.original.local.json." : "")
  );
}

main().catch((err) => { console.error("Capture failed:", err.message); process.exit(1); });
