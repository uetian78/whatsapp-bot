// ============================================================
//  Sign-in for the web app. No passwords, no email service.
//
//  The admin makes a personal link for each person (scripts/make-invite.js).
//  Opening the link only shows a "Sign in" button; pressing it sets a session
//  cookie. Access is ended by removing the number from the Allowed tab: every
//  request is checked against it, so a cookie alone is never enough.
//
//  Tokens are base64url(payload).hmac, HMAC-SHA256 with WEB_SECRET. The payload
//  carries a purpose ("invite" or "session"), so one kind can't stand in for
//  the other. With no WEB_SECRET the app is shut (503); there is no default.
// ============================================================
const crypto = require("node:crypto");
const express = require("express");
const { findAccount } = require("../lib/accounts.js");

const DAY = 24 * 60 * 60 * 1000;
const SESSION_DAYS = 180;
const COOKIE = "hv_session";
const MSG_SIGN_IN = "Ask for your personal link to sign in.";
const MSG_EXPIRED = "This link has expired. Ask for a new one.";

const nowOf = (now) => (typeof now === "function" ? now() : now ?? Date.now());

// ---- tokens ----
function sign(payload, secret) {
  if (!secret) throw new Error("WEB_SECRET is not set");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

// Constant-time compare that copes with different lengths (timingSafeEqual
// throws on those): hash both sides to equal-length digests first.
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// The payload object if the signature is right, else null. Never throws.
function open(token, secret) {
  try {
    if (!secret || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [body, mac] = parts;
    const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    if (!safeEqual(mac, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch (_) {
    return null;
  }
}

// The number a token of this purpose carries, or null (wrong purpose, expired).
function numberFrom(token, purpose, { secret, now }) {
  const p = open(token, secret);
  if (!p || p.p !== purpose) return null;
  if (typeof p.n !== "string" || !p.n) return null;
  if (typeof p.exp !== "number" || !(nowOf(now) < p.exp)) return null;
  return { number: p.n };
}

function makeInviteToken(number, { secret, now, days = 14 }) {
  const digits = String(number ?? "").replace(/\D/g, "");
  if (!digits) throw new Error("A number is needed");
  return sign({ p: "invite", n: digits, exp: nowOf(now) + days * DAY }, secret);
}
const verifyInviteToken = (token, { secret, now }) => numberFrom(token, "invite", { secret, now });

function makeSession(number, { secret, now }) {
  const digits = String(number ?? "").replace(/\D/g, "");
  if (!digits) throw new Error("A number is needed");
  return sign({ p: "session", n: digits, exp: nowOf(now) + SESSION_DAYS * DAY }, secret);
}

// Every hv_session value in a Cookie header, in order. Junk is skipped; a bad
// percent-escape just means that value is used as it is.
function cookieValues(header, name) {
  const out = [];
  for (const piece of String(header || "").split(";")) {
    const i = piece.indexOf("=");
    if (i < 0) continue;
    if (piece.slice(0, i).trim() !== name) continue;
    const raw = piece.slice(i + 1).trim();
    try { out.push(decodeURIComponent(raw)); } catch (_) { out.push(raw); }
  }
  return out;
}

function readSession(cookieHeader, { secret, now }) {
  for (const value of cookieValues(cookieHeader, COOKIE)) {
    const found = numberFrom(value, "session", { secret, now });
    if (found) return found;
  }
  return null;
}

// ---- pages ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f6f8;color:#1b2733}
main{background:#fff;border-radius:12px;padding:28px 24px;max-width:340px;margin:16px;box-shadow:0 1px 6px rgba(0,0,0,.12);text-align:center}
h1{font-size:1.2rem;margin:0 0 18px}
p{margin:0;line-height:1.5}
button{font:inherit;font-weight:600;color:#fff;background:#0b6bcb;border:0;border-radius:8px;padding:12px 28px;cursor:pointer}
</style></head><body><main>${body}</main></body></html>`;
}

const expiredPage = () => page("Link expired", `<h1>HVAC Assistant</h1><p>${MSG_EXPIRED}</p>`);
const signInPage = () => page("Sign in", `<h1>HVAC Assistant</h1><p>${MSG_SIGN_IN}</p>`);
const unavailablePage = () => page("Unavailable", `<h1>HVAC Assistant</h1><p>Sign-in is not available right now. Try again in a minute.</p>`);
const notSetUpPage = () => page("Unavailable", `<h1>HVAC Assistant</h1><p>The web app is not set up yet.</p>`);

// A browser asking for a page (not the API) gets HTML; everything else JSON.
function wantsHtml(req) {
  if (req.method !== "GET") return false;
  if (/^\/app\/api(\/|$)/.test(req.originalUrl || "")) return false;
  return String(req.headers?.accept || "").includes("text/html");
}

function deny(req, res, status, message, htmlPage) {
  res.set("Cache-Control", "no-store");
  if (wantsHtml(req)) return res.status(status).type("html").send(htmlPage());
  return res.status(status).json({ error: message });
}

// ---- who is signed in ----
// 401 with no valid session, or when the number is no longer on the Allowed
// tab. 503 when the Allowed list can't be read at all (never access by default)
// or WEB_SECRET is unset.
function requireUser({ secret, getAccounts, now }) {
  return async (req, res, next) => {
    if (!secret) return deny(req, res, 503, "The web app is not set up.", notSetUpPage);
    const session = readSession(req.headers?.cookie, { secret, now });
    if (!session) return deny(req, res, 401, MSG_SIGN_IN, signInPage);
    let accounts;
    try { accounts = await getAccounts(); }
    catch (err) {
      console.error("Sign-in check could not read the Allowed tab:", err.message);
      return deny(req, res, 503, "Sign-in is not available right now.", unavailablePage);
    }
    const account = findAccount(session.number, accounts);
    if (!account) return deny(req, res, 401, MSG_SIGN_IN, signInPage);
    req.account = account;
    next();
  };
}

// ---- the personal link ----
// A POST is only accepted from our own page. Browsers send `Origin: null` when
// a page says Referrer-Policy: no-referrer (as the sign-in page does), so
// Sec-Fetch-Site is the main signal; Origin is the fallback for browsers
// without it. A request with neither header (curl, old clients) is allowed.
function sameSiteRequest(req) {
  const fetchSite = req.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin";
  const origin = req.get("origin");
  if (origin === undefined) return true;
  try { return new URL(origin).host === req.get("host"); }
  catch (_) { return false; }
}

function joinRoutes({ secret, getAccounts, now }) {
  const router = express.Router();

  // Shut, with no exceptions, when there is no secret. The token is in the URL,
  // so these pages are never cached and never leak it in a Referer.
  router.use((req, res, next) => {
    if (!secret) return res.status(503).type("html").send(notSetUpPage());
    next();
  });
  router.use("/join", (req, res, next) => {
    res.set({ "Referrer-Policy": "no-referrer", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" });
    next();
  });

  // Who a link is for, if it is good and the number is still on the Allowed tab.
  async function resolve(token) {
    const found = verifyInviteToken(token, { secret, now });
    if (!found) return { status: 410 };
    let accounts;
    try { accounts = await getAccounts(); }
    catch (err) {
      console.error("Sign-in could not read the Allowed tab:", err.message);
      return { status: 503 };
    }
    const account = findAccount(found.number, accounts);
    return account ? { account } : { status: 410 };
  }
  const refuse = (res, r) => res.status(r.status).type("html").send(r.status === 503 ? unavailablePage() : expiredPage());

  router.get("/join/:token", async (req, res) => {
    const r = await resolve(req.params.token);
    if (!r.account) return refuse(res, r);
    const name = r.account.name || r.account.number;
    const action = escapeHtml(req.originalUrl.split("?")[0]);
    res.type("html").send(page("Sign in", `<h1>Sign in to HVAC Assistant as ${escapeHtml(name)}</h1>
<form method="post" action="${action}"><button type="submit">Sign in</button></form>`));
  });

  router.post("/join/:token", async (req, res) => {
    if (!sameSiteRequest(req)) return res.status(403).type("html").send(expiredPage());
    const r = await resolve(req.params.token);
    if (!r.account) return refuse(res, r);
    const value = makeSession(r.account.number, { secret, now });
    const secure = req.secure ? "; Secure" : "";
    res.set("Set-Cookie", `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/app; Max-Age=${SESSION_DAYS * 24 * 3600}${secure}`);
    res.redirect(303, "/app/");
  });

  return router;
}

module.exports = {
  makeInviteToken, verifyInviteToken, makeSession, readSession, requireUser, joinRoutes,
};
