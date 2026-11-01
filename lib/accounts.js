// ============================================================
//  Per-number accounts: name + plan, read from the Sheet's
//  Allowed tab (A = number, B = name, C = plan).
//
//  The Allowed tab is the gate for who may use the bot. The plan column is
//  still parsed (the sheet format is unchanged) but gates nothing: all text AI
//  sits behind one monthly spending cap (lib/ai.js).
//
//  The "who is asking" context rides on AsyncLocalStorage, NOT a
//  module-level variable: enqueue() serializes per user but runs
//  different users concurrently, so a shared variable would let
//  one account leak into another's request at every await.
//  This way the account follows the request through nested calls
//  (e.g. fallbackResolve -> aiMatchSeriesFile, three levels down)
//  without threading it through unrelated signatures.
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

// The one gate for who may use the bot: the sender's account, or null if they
// are not on the Allowed tab. Digits only, so "+974 5555 5555" matches
// "97455555555". An empty list lets nobody in.
function findAccount(from, accounts) {
  const number = normalizeNumber(from);
  if (!number || !accounts) return null;
  return accounts.get(number) || null;
}

// ---- Per-request account context ----
const store = new AsyncLocalStorage();

function runWithAccount(account, fn) {
  return store.run({ account: account || null }, fn);
}

function currentAccount() {
  return store.getStore()?.account || null;
}

module.exports = {
  parseAccounts, isPaidPlan, normalizeNumber, findAccount,
  runWithAccount, currentAccount,
};
