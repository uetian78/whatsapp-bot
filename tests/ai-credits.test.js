const test = require("node:test");
const assert = require("node:assert");
const {
  isCreditError, markExhausted, isExhausted, resetCredits,
  creditsExhaustedMessage, EXHAUSTED_TTL_MS,
} = require("../lib/ai-credits.js");

// The real shape the Anthropic SDK throws when the balance hits zero:
// HTTP 400, error.type "invalid_request_error", message names the balance.
function creditError() {
  const err = new Error(
    "400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\"," +
    "\"message\":\"Your credit balance is too low to access the Anthropic API. " +
    "Please go to Plans & Billing to upgrade or purchase credits.\"}}"
  );
  err.status = 400;
  err.type = "invalid_request_error";
  return err;
}

test("credit-exhaustion error is detected", () => {
  assert.equal(isCreditError(creditError()), true);
});

test("billing_error type is detected", () => {
  const err = new Error("Forbidden");
  err.status = 403;
  err.type = "billing_error";
  assert.equal(isCreditError(err), true);
});

// A rate limit is transient — retrying works, so it must NOT latch the bot
// into the premium message.
test("rate limit is not a credit error", () => {
  const err = new Error("429 rate_limit_error: too many requests");
  err.status = 429;
  err.type = "rate_limit_error";
  assert.equal(isCreditError(err), false);
});

// A bad/revoked key is an operator problem. Telling a customer to buy a plan
// would be wrong and would hide the real fault.
test("auth failure is not a credit error", () => {
  const err = new Error("401 authentication_error: invalid x-api-key");
  err.status = 401;
  err.type = "authentication_error";
  assert.equal(isCreditError(err), false);
});

test("network blips and undefined are not credit errors", () => {
  const err = new Error("socket hang up");
  assert.equal(isCreditError(err), false);
  assert.equal(isCreditError(null), false);
  assert.equal(isCreditError(undefined), false);
});

test("latch is off by default, set by markExhausted, cleared by reset", () => {
  resetCredits();
  assert.equal(isExhausted(), false);
  markExhausted();
  assert.equal(isExhausted(), true);
  resetCredits();
  assert.equal(isExhausted(), false);
});

// The TTL is what lets the bot recover on its own after a top-up, with no
// redeploy. Simulate the clock rather than waiting 10 real minutes.
test("latch expires after the TTL so a top-up recovers by itself", () => {
  resetCredits();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    markExhausted();
    assert.equal(isExhausted(), true);
    now += EXHAUSTED_TTL_MS - 1;
    assert.equal(isExhausted(), true, "still latched just inside the TTL");
    now += 2;
    assert.equal(isExhausted(), false, "cleared just past the TTL");
  } finally {
    Date.now = realNow;
    resetCredits();
  }
});

test("credits message greets by name, says credits are 0, gives the escape hatch", () => {
  const msg = creditsExhaustedMessage("Hassan");
  assert.match(msg, /Hassan/);
  assert.match(msg, /\*0\*/, "states the balance is zero");
  assert.match(msg, /exact file name/i);
});

// This person already pays. Telling them to upgrade would be nonsense, and
// was the bug this message replaced.
test("credits message never tells a paying customer to upgrade", () => {
  const msg = creditsExhaustedMessage("Hassan");
  assert.doesNotMatch(msg, /upgrade/i);
  assert.doesNotMatch(msg, /move to the \*?PAID/i);
});

test("credits message still reads correctly with no name on file", () => {
  const msg = creditsExhaustedMessage("");
  assert.doesNotMatch(msg, /Hi \*\*/, "no empty bold greeting");
  assert.match(msg, /\*0\*/);
});
