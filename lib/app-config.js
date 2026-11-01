// ============================================================
//  Which parts of the app are switched on, and which env vars
//  that needs. WhatsApp stays off unless WHATSAPP_ENABLED is
//  exactly "true", so a stray token in the environment can't
//  start answering messages by accident.
// ============================================================

function whatsappEnabled(env = process.env) {
  return env.WHATSAPP_ENABLED === "true";
}

// Env vars the app refuses to start without.
function requiredEnv(env = process.env) {
  const base = ["GOOGLE_SHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON"];
  return whatsappEnabled(env) ? [...base, "VERIFY_TOKEN", "WHATSAPP_TOKEN", "PHONE_NUMBER_ID"] : base;
}

module.exports = { whatsappEnabled, requiredEnv };
