// ============================================================
//  Anthropic credit-exhaustion state.
//  When the API key's balance hits zero EVERY Claude call in the
//  bot fails, so without this the customer gets a generic menu and
//  we burn five doomed round-trips per message. Detect the billing
//  error once, latch it, and let the router say something useful.
//  All non-AI features (files by exact name, menus, VRF/split/
//  chiller/schedule flows) never consult this and keep working.
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

// Shown to the customer in place of the AI-dependent tail of the router.
// Edit this one constant to reword the upgrade prompt.
const PREMIUM_UNAVAILABLE_MSG =
  "⚡ AI-powered answers and smart file search are premium features and are " +
  "currently unavailable.\n\n" +
  "Please move to the PAID plan to get access to premium features.\n\n" +
  "You can still get files — just type the *exact file name* " +
  "(for example \"APMR-A\" or \"ACMR IOM\"). Type \"menu\" to see everything I can do.";

module.exports = {
  isCreditError, markExhausted, isExhausted, resetCredits,
  PREMIUM_UNAVAILABLE_MSG, EXHAUSTED_TTL_MS,
};
