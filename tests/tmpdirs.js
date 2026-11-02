// Temp folders for tests, removed when the test process ends. Tests that made a
// folder and never removed it left a pile in the system temp folder on every run.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const made = [];

// A new empty folder in the temp folder, removed at exit.
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

// Remove a folder someone else made (an async mkdtemp, say) at exit.
function track(dir) {
  made.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of made) {
    // A database file still open on Windows can't go; a leftover temp folder is harmless.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (_) { /* leave it */ }
  }
});

module.exports = { tmpDir, track };
