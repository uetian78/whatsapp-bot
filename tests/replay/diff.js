// Replays the log now and compares it with a saved baseline.
//
//   node tests/replay/diff.js [baseline file]
//
// The baseline defaults to baseline.local.json; pass baseline.original.local.json
// to compare against the very first capture. Prints the count of each kind of
// difference and the first 20 of each. Exits 1 if any file was lost or a new
// not-found appeared.
const fs = require("fs");
const path = require("path");
const { replayAll, fixturePath } = require("./harness.js");

// The replies that mean "I couldn't give you what you asked for".
const NOT_FOUND = /Cannot find requested file|couldn't find anything matching|You are on the \*FREE\* plan|AI answers are paused right now|Even AI couldn't find anything|isn't available yet|couldn't fetch that image/i;

const filesOf = (e) => e.outbound.filter((o) => o.kind === "file").map((o) => o.file);
const isNotFound = (e) => e.outbound.some((o) => NOT_FOUND.test(o.text || ""));
const textOf = (e) => JSON.stringify(e.outbound.map((o) => ({ ...o, file: undefined })));

function compare(baseline, fresh) {
  const lost = [], newNotFound = [], changed = [];
  baseline.forEach((was, i) => {
    const now = fresh[i];
    const gone = filesOf(was).filter((f) => !filesOf(now).includes(f));
    if (gone.length) lost.push({ i, was, now, detail: `lost: ${gone.join(", ")}` });
    if (isNotFound(now) && !isNotFound(was)) newNotFound.push({ i, was, now, detail: "now not found" });
    if (textOf(was) !== textOf(now)) changed.push({ i, was, now, detail: "" });
  });
  return { lost, newNotFound, changed };
}

function show(title, list) {
  console.log(`${title}: ${list.length}`);
  for (const d of list.slice(0, 20)) {
    console.log(`  #${d.i} ${d.was.user} "${d.was.logged.slice(0, 60)}" ${d.detail}`);
  }
}

async function main() {
  const arg = process.argv[2];
  const file = arg ? path.resolve(arg) : fixturePath("baseline.local.json");
  if (!fs.existsSync(file)) throw new Error(`no baseline at ${file}: run capture-baseline.js first`);
  const baseline = JSON.parse(fs.readFileSync(file, "utf8"));
  const fresh = await replayAll();
  if (fresh.length !== baseline.length) {
    throw new Error(`the log has ${fresh.length} messages but the baseline has ${baseline.length}: recapture it`);
  }
  const { lost, newNotFound, changed } = compare(baseline, fresh);
  console.log(`Compared ${fresh.length} messages against ${path.basename(file)}`);
  show("files lost", lost);
  show("new not-found", newNotFound);
  show("text changed", changed);
  process.exit(lost.length || newNotFound.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => { console.error("Diff failed:", err.message); process.exit(1); });
}

module.exports = { compare, NOT_FOUND };
