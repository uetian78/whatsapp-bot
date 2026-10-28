// ============================================================
//  Bot number health.
//
//  Meta has more than once dropped the bot's number back to
//  PENDING (users see "This person is no longer available"),
//  which silently takes the bot offline until someone runs
//  scripts/register-number.js. This checks the number's status
//  and re-registers it with the two-step PIN when it has fallen
//  out. It also turns Meta's non-message webhook events
//  (account_update etc.) into log lines, so the next drop
//  leaves a trace of why.
// ============================================================

// Statuses that /register brings back. BANNED, FLAGGED, RESTRICTED etc. are
// Meta decisions that registering can't undo — those only get logged.
const HEALABLE = new Set(["PENDING", "DISCONNECTED"]);
const CHECK_EVERY_MS = 60 * 60 * 1000;
// Meta allows 10 /register calls per number per 72 h; 8 h apart keeps a
// number that won't come back at 9.
const REGISTER_GAP_MS = 8 * 60 * 60 * 1000;
const MAX_EVENT_CHARS = 1000;

function createNumberHealth({ getStatus, register, pin, now = Date.now, log = console.log }) {
  const validPin = /^\d{6}$/.test(pin || "") ? pin : null;
  let lastCheck = 0;
  let lastRegister = 0;
  let running = null;

  async function check() {
    lastCheck = now();
    let status;
    try {
      status = await getStatus();
    } catch (e) {
      log(`⚠️ Number health: status lookup failed: ${e.message}`);
      return { status: null };
    }
    if (status === "CONNECTED") return { status };
    if (!HEALABLE.has(status)) {
      log(`⚠️ Number health: number is ${status} — re-registering can't fix that, check WhatsApp Manager`);
      return { status };
    }
    if (!validPin) {
      log(`⚠️ Number health: number is ${status} and WHATSAPP_REGISTER_PIN is not a 6-digit PIN — run scripts/register-number.js`);
      return { status };
    }
    if (lastRegister && now() - lastRegister < REGISTER_GAP_MS) {
      log(`⚠️ Number health: number is still ${status}; next re-register attempt after ${new Date(lastRegister + REGISTER_GAP_MS).toISOString()}`);
      return { status };
    }
    lastRegister = now();
    try {
      await register(validPin);
      log(`✅ Number health: number was ${status}, re-registered`);
      return { status, registered: true };
    } catch (e) {
      log(`❌ Number health: number is ${status}, re-register failed: ${e.message}`);
      return { status, registered: false };
    }
  }

  // Runs a check unless one ran in the last CHECK_EVERY_MS; overlapping
  // callers share the one in flight. Never rejects.
  function maybeCheck() {
    if (running) return running;
    if (lastCheck && now() - lastCheck < CHECK_EVERY_MS) return Promise.resolve(null);
    running = check().finally(() => { running = null; });
    return running;
  }

  return { check, maybeCheck };
}

// One log line per webhook change that isn't a message/status ("messages"
// field) — account_update, phone_number_quality_update and the like.
function metaEventLines(body) {
  const lines = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      if (!change?.field || change.field === "messages") continue;
      const value = JSON.stringify(change.value ?? null);
      const shown = value.length > MAX_EVENT_CHARS ? value.slice(0, MAX_EVENT_CHARS) + "…" : value;
      lines.push(`📣 Meta event ${change.field}: ${shown}`);
    }
  }
  return lines;
}

module.exports = { createNumberHealth, metaEventLines, CHECK_EVERY_MS, REGISTER_GAP_MS };
