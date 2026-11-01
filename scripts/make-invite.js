// Makes a personal sign-in link for one person:
//   node scripts/make-invite.js 97455551234
// Prints PUBLIC_URL/app/join/<token> to this terminal; send it to that person
// yourself. It needs WEB_SECRET and PUBLIC_URL (from .env or the environment)
// and does not look at the Sheet: the number must be on the Allowed tab when
// they press Sign in. The link works for 14 days.
const { makeInviteToken } = require("../web/auth.js");

function run({ argv, env, now = Date.now() }) {
  const fail = (message) => ({ code: 1, out: "", err: message });
  const raw = argv[0];
  if (!raw) return fail("Usage: node scripts/make-invite.js <number>   (digits, with country code, e.g. 97455551234)");
  const number = String(raw).replace(/\D/g, "");
  if (number.length < 7 || number.length > 15) return fail(`"${raw}" is not a phone number: expected 7 to 15 digits including the country code.`);
  if (!env.WEB_SECRET) return fail("WEB_SECRET is not set. Add it to .env (any long random string) before making links.");
  if (!env.PUBLIC_URL) return fail("PUBLIC_URL is not set. Add it to .env, e.g. https://your-app.up.railway.app");
  let base;
  try {
    base = new URL(env.PUBLIC_URL);
    if (!/^https?:$/.test(base.protocol)) throw new Error("scheme");
  } catch (_) {
    return fail("PUBLIC_URL must be a full web address starting with https:// (or http://).");
  }
  const token = makeInviteToken(number, { secret: env.WEB_SECRET, now });
  return { code: 0, out: `${base.origin}${base.pathname.replace(/\/+$/, "")}/app/join/${token}`, err: "" };
}

if (require.main === module) {
  require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
  const r = run({ argv: process.argv.slice(2), env: process.env });
  if (r.err) console.error(r.err);
  if (r.out) console.log(r.out);
  process.exit(r.code);
}

module.exports = { run };
