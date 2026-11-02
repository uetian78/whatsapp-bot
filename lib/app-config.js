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

// Lines to print at start about settings that are missing or wrong but don't
// stop the app. Data loss and dead share links are silent otherwise.
function startupWarnings(env = process.env) {
  const path = require("node:path");
  const { dataDir } = require("./db.js");
  const out = [];
  const dir = dataDir(env);
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH;
  if (env.RAILWAY_ENVIRONMENT) {
    if (!mount) {
      out.push("❌ DATA LOSS: this is a Railway deploy with no volume attached. Everything saved (chats, files, search) is lost on every deploy and restart. Add a volume and set DATA_DIR to its mount path (/data).");
    } else if (path.resolve(dir) !== path.resolve(mount)) {
      out.push(`❌ DATA LOSS: the data folder is ${dir} but the Railway volume is mounted at ${mount}. Everything saved is lost on every deploy. Set DATA_DIR=${mount}.`);
    }
  } else if (!env.DATA_DIR) {
    out.push(`⚠️  DATA_DIR is not set — saving to ${dir}. On Railway set DATA_DIR to the volume's mount path (/data).`);
  }
  if (env.RAILWAY_ENVIRONMENT && !env.DATA_DIR && mount) {
    out.push(`⚠️  DATA_DIR is not set — using the Railway volume at ${mount}. Set DATA_DIR=${mount} to make this explicit.`);
  }
  if (!env.PUBLIC_URL) {
    out.push("⚠️  PUBLIC_URL is not set — share links answer 503 until it is (use the app's public address, e.g. https://your-app.up.railway.app).");
  }
  return out;
}

module.exports = { whatsappEnabled, requiredEnv, startupWarnings };
