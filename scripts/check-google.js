// Read-only check that Google auth, Drive and the rules Sheet still work.
//
//   node scripts/check-google.js
//
// Prints "Google OK: <n> files, Sheet readable" on success. On failure prints
// a short reason (never credentials) and exits non-zero. Reads only.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

async function main() {
  // Required after dotenv: these modules read process.env at load time.
  const { getSheets } = require("../lib/google.js");
  const { listFolderFiles } = require("../lib/drive-index.js");

  const files = await listFolderFiles();
  const sheets = await getSheets();
  await sheets.spreadsheets.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    fields: "spreadsheetId",
  });
  return files.length;
}

// Silence the index's chatty progress logs so only the result line shows.
const realLog = console.log;
console.log = () => {};
main().then(
  (n) => { console.log = realLog; console.log(`Google OK: ${n} files, Sheet readable`); process.exit(0); },
  (err) => {
    console.log = realLog;
    const status = err && (err.code || (err.response && err.response.status));
    console.error("Google check FAILED:", String((err && err.message) || err).split("\n")[0].slice(0, 160), status ? `(${status})` : "");
    process.exit(1);
  }
);
