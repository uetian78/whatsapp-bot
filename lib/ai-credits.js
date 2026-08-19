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

// Shown to a PAID account when the balance is empty. Deliberately different
// from the free-plan message: this person already pays, so prompting them to
// "upgrade" would be wrong. Say the credits are gone and give them the
// exact-filename path, which needs no AI.
function creditsExhaustedMessage(name) {
  const who = name ? ` *${name}*` : "";
  return (
    `Hi${who} 👋\n\n` +
    "Your AI credits are *0* — premium search features are paused until " +
    "credits are added.\n\n" +
    "*OR*\n\n" +
    "Type the exact file name to get it (for example \"APMR-A\" or \"ACMR IOM\")."
  );
}

module.exports = {
  isCreditError, markExhausted, isExhausted, resetCredits,
  creditsExhaustedMessage, EXHAUSTED_TTL_MS,
};
