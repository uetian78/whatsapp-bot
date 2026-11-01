// Exports the real message log and the bot's control data into local fixtures
// for the replay test. Reads only (Sheets values.get/batchGet, Drive list).
//
//   node tests/replay/export-log.js
//
// Writes, next to this file (all gitignored, *.local.json):
//   messages.local.json  [{ time, user, text }]  oldest first
//   sheet.local.json     { rules, knowledge, allowed, adminNumbers }
//   drive.local.json     the Drive file index the bot searches
//
// Privacy: every phone number becomes 100000001, 100000002, ... (the same
// person keeps the same fake number everywhere, including the Allowed tab),
// profile names are dropped, and an Allowed-tab name becomes "Name <n>" so
// "has a name" still behaves the same. The real numbers and names must not
// survive in any fixture; the script checks and refuses to write if they do.
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const DIR = __dirname;
// crm.js keeps its own default and does not export it.
const CRM_SHEET_ID = process.env.CRM_SHEET_ID || "1EbAXIZrjaelovg8APOaWhdg7FVnLxyO6-I2bMzIE2JM";

const digits = (s) => String(s ?? "").replace(/\D/g, "");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Qatar time ("2026-06-12 22:41:05", UTC+3, no DST) as a sortable instant.
const instant = (t) => Date.parse(String(t).trim().replace(" ", "T") + "+03:00");

async function main() {
  // Required after dotenv: these modules read process.env at load time.
  const { getSheets } = require("../../lib/google.js");
  const { listFolderFiles } = require("../../lib/drive-index.js");
  const { alertNumbers } = require("../../lib/doc-requests.js");

  const log = console.log;
  console.log = () => {}; // the Drive index prints every file it finds
  const sheets = await getSheets();

  const logRes = await sheets.spreadsheets.values.get({ spreadsheetId: CRM_SHEET_ID, range: "Log!A2:F" });
  const control = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    ranges: ["Rules!A2:F", "Knowledge!A2:B", "Allowed!A2:C"],
  });
  const driveFiles = await listFolderFiles();
  console.log = log;

  const [rules, knowledge, allowedRaw] = control.data.valueRanges.map((r) => r.values || []);

  // Log columns: Time | Phone | Name | Message | Intent | Bot response.
  // Oldest first; the sort is stable, so one user's messages never reorder.
  const rows = (logRes.data.values || [])
    .filter((r) => r[0] && r[1] && r[3] !== undefined)
    .map((r) => ({ time: String(r[0]), phone: digits(r[1]), name: String(r[2] || "").trim(), text: String(r[3]) }))
    .filter((r) => r.phone && !Number.isNaN(instant(r.time)))
    .sort((a, b) => instant(a.time) - instant(b.time));

  // Real number -> fake number, in order of first appearance, then Allowed
  // numbers nobody has messaged from, then the admin numbers.
  const fake = new Map();
  const fakeFor = (real) => {
    const d = digits(real);
    if (!fake.has(d)) fake.set(d, String(100000001 + fake.size));
    return fake.get(d);
  };
  for (const r of rows) fakeFor(r.phone);
  for (const r of allowedRaw) if (digits(r[0])) fakeFor(r[0]);
  const admins = alertNumbers(process.env).map(fakeFor);

  // Every name we know, to keep out of the text.
  const realNames = new Set();
  for (const r of rows) if (r.name) realNames.add(r.name);
  for (const r of allowedRaw) if (String(r[1] || "").trim()) realNames.add(String(r[1]).trim());
  const nameList = [...realNames].filter((n) => n.length >= 3).sort((a, b) => b.length - a.length);
  const namePatterns = nameList.map((n) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "giu"));
  const numberPatterns = [...fake.keys()].sort((a, b) => b.length - a.length)
    .map((d) => new RegExp(d.split("").map(escapeRe).join("[\\s-]?"), "g"));

  // Real numbers and names inside free text -> neutral stand-ins.
  const scrub = (text) => {
    let out = String(text);
    for (const re of numberPatterns) out = out.replace(re, (m) => fake.get(digits(m)) || "100000000");
    for (const re of namePatterns) out = out.replace(re, "Name");
    return out;
  };
  const scrubDeep = (v) => (Array.isArray(v) ? v.map(scrubDeep) : typeof v === "string" ? scrub(v) : v);

  const messages = rows.map((r) => ({ time: r.time, user: fakeFor(r.phone), text: scrub(r.text) }));

  // Allowed tab: A = number, B = name, C = plan. Users who wrote to the bot
  // but are no longer listed are added as plain (free, unnamed) accounts so
  // the replay can still answer them.
  const nameNumber = new Map();
  const allowed = allowedRaw.filter((r) => digits(r[0])).map((r) => {
    const user = fakeFor(r[0]);
    const named = String(r[1] || "").trim() !== "";
    if (named && !nameNumber.has(user)) nameNumber.set(user, `Name ${user.slice(-3)}`);
    return [user, named ? nameNumber.get(user) : "", String(r[2] ?? "")];
  });
  const listed = new Set(allowed.map((a) => a[0]));
  const unlisted = [...new Set(messages.map((m) => m.user))].filter((u) => !listed.has(u));
  for (const u of unlisted) allowed.push([u, "", ""]);

  const sheet = {
    rules: scrubDeep(rules),
    knowledge: scrubDeep(knowledge),
    allowed,
    adminNumbers: admins,
  };
  const drive = scrubDeep(driveFiles);

  // Refuse to write a fixture that still holds a real number or full name.
  const blob = JSON.stringify([messages, sheet, drive]);
  const leakedNumbers = [...fake.keys()].filter((d) => d.length >= 6 && blob.includes(d));
  const leakedNames = nameList.filter((n) => blob.toLowerCase().includes(n.toLowerCase()));
  if (leakedNumbers.length || leakedNames.length) {
    throw new Error(`fixtures still hold ${leakedNumbers.length} real number(s) and ${leakedNames.length} name(s); nothing written`);
  }

  fs.writeFileSync(path.join(DIR, "messages.local.json"), JSON.stringify(messages));
  fs.writeFileSync(path.join(DIR, "sheet.local.json"), JSON.stringify(sheet));
  fs.writeFileSync(path.join(DIR, "drive.local.json"), JSON.stringify(drive));

  const taps = messages.filter((m) => m.text.startsWith("btn:")).length;
  console.log(
    `Exported ${messages.length} messages (${taps} button taps) from ${new Set(messages.map((m) => m.user)).size} users; ` +
    `${rules.length} rules, ${knowledge.length} knowledge rows, ${allowed.length} accounts ` +
    `(${unlisted.length} added because they are no longer listed), ${drive.length} Drive files.`
  );
}

main().catch((err) => {
  console.error("Export failed:", String((err && err.message) || err).split("\n")[0].slice(0, 200));
  process.exit(1);
});
