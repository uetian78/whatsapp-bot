// ============================================================
//  Anthropic credit-exhaustion state.
//  When the API key's balance hits zero EVERY Claude call in the
//  bot fails, so without this the customer gets a generic menu and
//  we burn five doomed round-trips per message. Detect the billing
//  error once, latch it, and let the router say something useful.
//  All non-AI features (files by exact name, menus, chiller and package
//  selection) never consult this and keep working.
// ============================================================

// How long a single detection suppresses further Claude calls. Short
// enough that a top-up recovers the bot on its own with no redeploy,
// long enough that we're not re-probing a dead key on every message.
const EXHAUSTED_TTL_MS = 10 * 60 * 1000;

let exhaustedAt = 0;

// Is this error an empty balance, as opposed to a rate limit or a bad key?
//
// The Anthropic API reports an empty balance two ways:
//   - 400 invalid_request_error, message "Your credit balance is too low..."
//   - an error whose .type is "billing_error"
//
// 429 (rate_limit_error) and 401 (authentication_error) are deliberately NOT
// credit errors: a rate limit is transient and retrying works, and a revoked
// key is an operator fault that must not be dressed up as a billing message
// to a customer.
function isCreditError(err) {
  if (!err) return false;
  if (err.type === "billing_error") return true;
  const status = err.status ?? err.statusCode;
  const message = String(err.message || "");
  if (status === 429 || status === 401) return false;
  return /credit balance is too low/i.test(message);
}

function markExhausted() {
  exhaustedAt = Date.now();
}

function isExhausted() {
  return exhaustedAt > 0 && Date.now() - exhaustedAt <= EXHAUSTED_TTL_MS;
}

// Test-only: clear the latch between cases.
function resetCredits() {
  exhaustedAt = 0;
}

// Shown when a typed name matched no file and the AI that helps find one is
// unavailable: no key, the credit latch is set, or the monthly cap is reached.
// Says nothing about plans or money — only what still works.
function aiPausedMessage() {
  return "I couldn't find a document for that, and AI file finding is paused right now. You can still get any document by its name.";
}

module.exports = {
  isCreditError, markExhausted, isExhausted, resetCredits,
  aiPausedMessage, EXHAUSTED_TTL_MS,
};
