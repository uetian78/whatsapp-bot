// ============================================================
//  Per-number accounts: name + plan, read from the Sheet's
//  Allowed tab (A = number, B = name, C = plan).
//
//  Only PAID numbers may use the Claude-backed features. Free
//  numbers keep everything deterministic — filename search, the
//  numbered file list, VRF/split/chiller/schedule flows, the
//  menu, PDF delivery — they just never cost an API call.
//
//  The "who is asking" context rides on AsyncLocalStorage, NOT a
//  module-level variable: enqueue() serializes per user but runs
//  different users concurrently, so a shared variable would let
//  one account's plan leak into another's request at every await.
//  This way the account follows the request through nested calls
//  (e.g. fallbackResolve -> aiMatchSeriesFile, three levels down)
//  without threading a billing flag through unrelated signatures.
// ============================================================
const { AsyncLocalStorage } = require("node:async_hooks");

// Deliberately generous about what counts as paid — this column is
// typed by hand in a spreadsheet, not validated on entry.
const PAID_VALUES = new Set(["paid", "premium", "yes", "y", "true", "1", "pro"]);

// Same rule the existing allowlist uses (server.js): digits only, so
// "+974 1234 5678" and "97412345678" are the same person.
function normalizeNumber(value) {
  return String(value ?? "").replace(/\D/g, "");
}

// Anything unrecognised — including a blank cell — is free. A number must be
// explicitly marked paid to spend API credit.
function isPaidPlan(value) {
  return PAID_VALUES.has(String(value ?? "").trim().toLowerCase());
}

// Sheet rows -> Map(number -> { number, name, paid }). Rows without a number
// are skipped; a missing name or plan column is fine.
function parseAccounts(rows) {
  const accounts = new Map();
  for (const row of rows || []) {
    const number = normalizeNumber(row?.[0]);
    if (!number) continue;
    accounts.set(number, {
      number,
      name: String(row?.[1] ?? "").trim(),
      paid: isPaidPlan(row?.[2]),
    });
  }
  return accounts;
}

// ---- Per-request account context ----
const store = new AsyncLocalStorage();

function runWithAccount(account, fn) {
  return store.run({ account: account || null }, fn);
}

function currentAccount() {
  return store.getStore()?.account || null;
}

// May the caller use Claude? With no account in context the bot is running
// open (empty Allowed tab), which is how it behaved before accounts existed —
// keep AI on rather than silently disabling it for everyone.
function aiAllowed() {
  const account = currentAccount();
  return account ? account.paid === true : true;
}

// Shown to a free number in place of any AI-backed reply. Edit here to reword.
function freePlanMessage(name) {
  const who = name ? ` *${name}*` : "";
  return (
    `Hi${who} 👋\n\n` +
    "You are on the *FREE* plan — upgrade to the *PAID* plan to get premium " +
    "search features.\n\n" +
    "*OR*\n\n" +
    "Type the exact file name to get it (for example \"APMR-A\" or \"ACMR IOM\")."
  );
}

module.exports = {
  parseAccounts, isPaidPlan, normalizeNumber,
  runWithAccount, currentAccount, aiAllowed, freePlanMessage,
};
