const test = require("node:test");
const assert = require("node:assert");
const {
  parseAccounts, isPaidPlan, normalizeNumber,
  runWithAccount, currentAccount, aiAllowed, freePlanMessage,
} = require("../lib/accounts.js");

test("plan column accepts the spellings a human actually types", () => {
  for (const yes of ["paid", "PAID", " Paid ", "premium", "yes", "y", "true", "1", "pro"]) {
    assert.equal(isPaidPlan(yes), true, `${JSON.stringify(yes)} should be paid`);
  }
  for (const no of ["free", "FREE", "no", "0", "trial", "", "   ", null, undefined]) {
    assert.equal(isPaidPlan(no), false, `${JSON.stringify(no)} should be free`);
  }
});

// Matches the existing allowlist rule at server.js — digits only, so
// "+974 1234 5678" and "97412345678" are the same person.
test("numbers are normalized to digits, like the existing allowlist", () => {
  assert.equal(normalizeNumber("+974 1234-5678"), "97412345678");
  assert.equal(normalizeNumber("97412345678"), "97412345678");
  assert.equal(normalizeNumber(""), "");
  assert.equal(normalizeNumber(null), "");
});

test("parseAccounts builds a lookup keyed by normalized number", () => {
  const accounts = parseAccounts([
    ["+974 1111 1111", "Hassan", "paid"],
    ["97422222222", "Ali", "free"],
    ["97433333333", "Sara"],            // no plan column -> free
    ["", "Ghost", "paid"],              // no number -> skipped
  ]);

  assert.equal(accounts.size, 3);
  assert.deepEqual(accounts.get("97411111111"), {
    number: "97411111111", name: "Hassan", paid: true,
  });
  assert.equal(accounts.get("97422222222").paid, false);
  assert.equal(accounts.get("97433333333").paid, false, "blank plan means free");
  assert.equal(accounts.has(""), false);
});

test("parseAccounts tolerates an empty or missing sheet range", () => {
  assert.equal(parseAccounts([]).size, 0);
  assert.equal(parseAccounts(null).size, 0);
  assert.equal(parseAccounts(undefined).size, 0);
});

// The Allowed tab still carries a name per number. Plans no longer gate
// anything, but the account still follows the request through awaits.
test("the account rides the request context", async () => {
  const hassan = { number: "1", name: "Hassan", paid: true };
  const ali = { number: "2", name: "Ali", paid: false };

  await runWithAccount(hassan, async () => assert.equal(currentAccount().name, "Hassan"));
  await runWithAccount(ali, async () => assert.equal(currentAccount().name, "Ali"));
  assert.equal(currentAccount(), null, "no context outside a request");
});

// The reason this uses AsyncLocalStorage and not a module-level variable:
// enqueue() serializes per user but runs different users concurrently, so a
// shared variable would let one account leak into another's request.
test("concurrent accounts do not leak into each other across awaits", async () => {
  const seen = [];

  const slow = runWithAccount({ number: "1", name: "Hassan" }, async () => {
    await new Promise((r) => setTimeout(r, 20)); // the other request runs during this
    seen.push(["after-await", currentAccount().name]);
  });
  const fast = runWithAccount({ number: "2", name: "Ali" }, async () => {
    seen.push(["fast", currentAccount().name]);
  });

  await Promise.all([slow, fast]);

  assert.deepEqual(seen, [
    ["fast", "Ali"],
    ["after-await", "Hassan"],
  ]);
});

test("the plan helpers are gone: nothing is gated by plan any more", () => {
  const accounts = require("../lib/accounts.js");
  assert.equal(accounts.aiAllowed, undefined);
  assert.equal(accounts.freePlanMessage, undefined);
});

// ---- findAccount: the single gate for who may use the bot ----
const { findAccount } = require("../lib/accounts.js");

test("findAccount matches digits only", () => {
  const accounts = parseAccounts([["97455555555", "Sara", "paid"]]);
  assert.equal(findAccount("+974 5555 5555", accounts).number, "97455555555");
  assert.equal(findAccount("97455555555", accounts).name, "Sara");
});

test("findAccount returns null for a number that is not listed", () => {
  const accounts = parseAccounts([["97455555555", "Sara"]]);
  assert.equal(findAccount("97466666666", accounts), null);
  assert.equal(findAccount("", accounts), null);
  assert.equal(findAccount(undefined, accounts), null);
});

test("an empty Allowed list lets nobody in", () => {
  assert.equal(findAccount("97455555555", new Map()), null);
  assert.equal(findAccount("97455555555", undefined), null);
});
