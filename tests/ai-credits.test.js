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

const { isAiUnavailableError, aiFeatureUnavailableMessage } = require("../lib/ai-credits.js");

// The vision helpers throw plain Errors shaped "... API <status>: <json>", so
// the status has to be read out of the message text, not just off the object.
test("a refused API call is recognised from the thrown message", () => {
  const refused = [
    'schedule extraction API 401: {"error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    'extraction API 401: {"error":{"type":"authentication_error","message":"missing x-api-key"}}',
    'extraction API 403: {"error":{"type":"permission_error"}}',
    'schedule extraction API 400: {"error":{"message":"Your credit balance is too low to access the Anthropic API."}}',
  ];
  for (const m of refused) {
    assert.equal(isAiUnavailableError(new Error(m)), true, m.slice(0, 45));
  }
});

// A blurry photo is fixable by resending; a rate limit by waiting. Neither
// should tell the customer to buy a plan.
test("a real extraction failure is NOT reported as a billing problem", () => {
  const normal = [
    "no JSON found in model reply",
    'schedule extraction API 400: {"error":{"message":"could not process image"}}',
    'extraction API 429: {"error":{"type":"rate_limit_error"}}',
    "socket hang up",
  ];
  for (const m of normal) {
    assert.equal(isAiUnavailableError(new Error(m)), false, m.slice(0, 45));
  }
  assert.equal(isAiUnavailableError(null), false);
});

// A disabled key must NOT latch the credits flag — the balance is fine, and
// latching would mask the real fault for 10 minutes.
test("a disabled key is unavailable but is not a credit error", () => {
  const err = new Error('extraction API 401: {"error":{"type":"authentication_error"}}');
  assert.equal(isAiUnavailableError(err), true);
  assert.equal(isCreditError(err), false, "must not be mistaken for an empty balance");
});

test("the feature message names credits and the paid plan", () => {
  const msg = aiFeatureUnavailableMessage("Hassan");
  assert.match(msg, /Hassan/);
  assert.match(msg, /AI credits are required/i);
  assert.match(msg, /PAID/);
  assert.doesNotMatch(aiFeatureUnavailableMessage(""), /Hi \*\*/);
});
