// ============================================================
//  Password gate for the admin pages (/drive-index, /vrf-health).
//  HTTP Basic: any username, the password is ADMIN_PASSWORD.
//  With no ADMIN_PASSWORD set the pages stay shut (503) rather
//  than falling open.
// ============================================================
const crypto = require("node:crypto");

// timingSafeEqual throws on different lengths, so hash both sides first:
// equal-length digests, and the length of the real password isn't leaked.
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// "Basic base64(user:pass)" -> pass, or null. The password may contain colons.
function passwordFrom(header) {
  const m = /^Basic\s+(\S+)$/i.exec(String(header || ""));
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const i = decoded.indexOf(":");
  return i < 0 ? null : decoded.slice(i + 1);
}

function requireAdmin(env = process.env) {
  return (req, res, next) => {
    const expected = env.ADMIN_PASSWORD;
    if (!expected) return res.status(503).type("text/plain").send("Admin pages are disabled: ADMIN_PASSWORD is not set.");
    const given = passwordFrom(req.headers?.authorization);
    if (given !== null && safeEqual(given, expected)) return next();
    res.set("WWW-Authenticate", 'Basic realm="Admin", charset="UTF-8"');
    return res.status(401).type("text/plain").send("Authentication required.");
  };
}

module.exports = { requireAdmin };
