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

test("paid account may use AI, free account may not", async () => {
  const paid = { number: "1", name: "Hassan", paid: true };
  const free = { number: "2", name: "Ali", paid: false };

  await runWithAccount(paid, async () => {
    assert.equal(aiAllowed(), true);
    assert.equal(currentAccount().name, "Hassan");
  });
  await runWithAccount(free, async () => {
    assert.equal(aiAllowed(), false);
    assert.equal(currentAccount().name, "Ali");
  });
});

// Backwards compatibility: with no Allowed rows the bot is open to everyone
// and there is no account to consult. Gating AI off there would silently
// break every existing deployment, so no-context means allowed.
test("no account context leaves AI allowed (open-bot default)", () => {
  assert.equal(currentAccount(), null);
  assert.equal(aiAllowed(), true);
});

// The reason this uses AsyncLocalStorage and not a module-level variable:
// enqueue() serializes per user but runs different users concurrently, so a
// shared variable would let one account's plan leak into another's request.
test("concurrent accounts do not leak into each other across awaits", async () => {
  const paid = { number: "1", name: "Hassan", paid: true };
  const free = { number: "2", name: "Ali", paid: false };
  const seen = [];

  const slowPaid = runWithAccount(paid, async () => {
    await new Promise((r) => setTimeout(r, 20)); // free request runs during this
    seen.push(["paid-after-await", currentAccount().name, aiAllowed()]);
  });
  const fastFree = runWithAccount(free, async () => {
    seen.push(["free", currentAccount().name, aiAllowed()]);
  });

  await Promise.all([slowPaid, fastFree]);

  assert.deepEqual(seen, [
    ["free", "Ali", false],
    ["paid-after-await", "Hassan", true],
  ]);
});

test("free-plan message greets by name and names the escape hatch", () => {
  const msg = freePlanMessage("Hassan");
  assert.match(msg, /Hassan/);
  assert.match(msg, /FREE/);
  assert.match(msg, /PAID/);
  assert.match(msg, /exact file name/i);
});

test("free-plan message still reads correctly with no name on file", () => {
  const msg = freePlanMessage("");
  assert.doesNotMatch(msg, /Hi \*\*/, "no empty bold greeting");
  assert.match(msg, /PAID/);
});
