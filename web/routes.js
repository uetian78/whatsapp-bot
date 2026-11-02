// ============================================================
//  The web app's API: messages, uploads, files and share links.
//
//  Mount the router at the root, after mountWeb (web/auth.js): everything under
//  /app is then behind the sign-in check, and /s/<token> (public) is not.
//
//    GET  /app/api/messages?after=<seq>   { messages, busy }
//    POST /app/api/messages               { text } | { tapId, tapTitle, data? } -> 202 { seq }
//    POST /app/api/upload?name=<name>     raw body -> 202 { seq }
//    GET  /app/files/<ref>[?inline=1]     drive:<id> | gen:<uuid>, streamed
//    POST /app/api/share-link             { ref } -> { url }
//    GET  /s/<token>                      the shared file, no sign-in
//    GET  /app/, /app/app.js, ...         the chat screen (web/public), signed-in people only
//
//  A message from the person is saved first, then handed to deliverMessage
//  (server.js) exactly as the WhatsApp webhook would, with the web channel.
//  The POST does not wait for the reply: the page polls GET and sees the
//  bot's messages arrive. Files are piped to the response and never held whole.
// ============================================================
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { pipeline } = require("node:stream");
const express = require("express");
const { sameSiteRequest, makeShareToken, verifyShareToken, cleanSecret } = require("./auth.js");
const { cleanFileName, classifyUpload, readLimited, drain, MAX_BYTES } = require("./uploads.js");

const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_TEXT = 4000;
const MAX_TAP_FIELD = 200;
const MAX_TAP_DATA = 4000;
const MAX_TABLE_DATA = 90000; // the schedule table's tap (rows-ok) carries a whole table; express.json stops anything over 100 KB
const TABLE_TAP = "rows-ok";
const PAGE_SIZE = 200;
const DRIVE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MSG_TOO_LARGE = "That file is too large. The limit is 32 MB.";
const MSG_BAD_TYPE = "Send a photo, PDF or Excel file.";

// Every response from /app and /s: same-origin only, no inline script, no
// plugins, no framing. Pictures may also come from blob: and data: so the page
// can preview what is being sent.
const CSP = "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

// ---- file names and types ----
const MIME_BY_EXT = {
  pdf: "application/pdf",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
};
// Only these may be shown in the browser itself. Everything else, and anything
// that could run script (HTML, SVG), is a download.
const INLINE_OK = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const KNOWN_MIME = new Set(Object.values(MIME_BY_EXT));

function mimeFor(name, preferred) {
  if (preferred && KNOWN_MIME.has(preferred)) return preferred;
  const ext = (String(name || "").split(".").pop() || "").toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

// Content-Disposition that Node accepts whatever the name holds: controls, line
// breaks, path separators and bidi tricks are removed, `filename=` is a plain
// ASCII fallback, and `filename*=` carries the real name.
function contentDisposition(name, inline = false) {
  let clean = typeof name === "string" ? name.toWellFormed() : "";
  clean = clean.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/[\\/]/g, "_").trim();
  clean = Array.from(clean).slice(0, 150).join("") || "file";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%]/g, "_");
  const star = encodeURIComponent(clean).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

// ---- pages for /s ----
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function notice(message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>HVAC Assistant</title>
<style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f6f8;color:#1b2733}main{background:#fff;border-radius:12px;padding:28px 24px;max-width:340px;margin:16px;box-shadow:0 1px 6px rgba(0,0,0,.12);text-align:center}h1{font-size:1.2rem;margin:0 0 18px}p{margin:0;line-height:1.5}</style>
</head><body><main><h1>HVAC Assistant</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

// ---- errors ----
// Mount this on /app in server.js too: a body that isn't valid JSON fails inside
// express.json() before the router is reached. JSON for the page's fetch calls,
// never a stack trace.
function webErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err && (err.status || err.statusCode)) && (err.status || err.statusCode) >= 400 && (err.status || err.statusCode) < 600
    ? (err.status || err.statusCode) : 500;
  if (status >= 500) console.error("Web route error:", err && err.message);
  const error = status === 413 ? "That request is too large." : status >= 500 ? "Something went wrong. Try again." : "That request could not be read.";
  res.status(status).set("Cache-Control", "no-store").json({ error });
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createWebRoutes({
  deliverMessage, conversations, webChannel, getFile, uploads,
  streamDrive, streamExport, sendWelcome,
  secret: rawSecret, publicUrl, now, maxUploadBytes = MAX_BYTES,
}) {
  const secret = cleanSecret(rawSecret);
  const router = express.Router();
  const google = () => require("../lib/google.js");
  const openDrive = (id) => (streamDrive || google().streamDriveFile)(id);
  const openExport = (id, mime) => (streamExport || google().streamDriveExport)(id, mime);

  router.use(["/app", "/s"], (req, res, next) => {
    res.set({ "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff" });
    next();
  });
  router.use("/s", (req, res, next) => {
    res.set({ "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer", "Cache-Control": "private" });
    next();
  });

  // ---- who is waiting for a reply ----
  const busy = new Map(); // number -> messages still being handled (in memory only)
  const isBusy = (number) => (busy.get(number) || 0) > 0;

  // Saves nothing itself. Runs deliverMessage in the background: a failure is
  // logged (never the message) and busy clears either way.
  function handle(account, message, afterwards) {
    const number = account.number;
    busy.set(number, (busy.get(number) || 0) + 1);
    const value = { contacts: [{ profile: { name: account.name || "" } }] };
    (async () => deliverMessage(value, message, webChannel))()
      .catch((err) => console.error("Web message failed:", err && err.message))
      .finally(() => {
        const left = (busy.get(number) || 1) - 1;
        if (left > 0) busy.set(number, left); else busy.delete(number);
        if (afterwards) afterwards();
      });
  }
  const baseMessage = (number) => ({
    from: number,
    id: `web.${crypto.randomUUID()}`,
    timestamp: String(Math.floor((typeof now === "function" ? now() : now ?? Date.now()) / 1000)),
  });

  // ---- the welcome, once ----
  // The first time someone opens an empty conversation the bot says what
  // typing "menu" says. Polls that arrive meanwhile share the one attempt.
  const welcoming = new Map();
  function welcomeOnce(account) {
    let p = welcoming.get(account.number);
    if (!p) {
      p = Promise.resolve()
        .then(() => sendWelcome(account))
        .catch((err) => console.error("Welcome failed:", err && err.message))
        .finally(() => welcoming.delete(account.number));
      welcoming.set(account.number, p);
    }
    return p;
  }

  // ---- guards for POST ----
  // SameSite=Lax already keeps the cookie off cross-site POSTs; this is the second layer.
  const sameSite = (req, res, next) => {
    if (!sameSiteRequest(req)) return res.status(403).json({ error: "That request was not sent from this page." });
    next();
  };
  const jsonOnly = (req, res, next) => {
    if (!req.is("application/json")) return res.status(415).json({ error: "Send JSON." });
    next();
  };

  // ---- messages ----
  router.get("/app/api/messages", wrap(async (req, res) => {
    const account = req.account;
    const user = account.number;
    if (sendWelcome && conversations.isEmpty(user)) await welcomeOnce(account);
    const after = Number.parseInt(req.query.after, 10);
    const messages = after > 0 ? conversations.since(user, after, PAGE_SIZE) : conversations.latest(user, PAGE_SIZE);
    res.set("Cache-Control", "no-store").json({ messages, busy: isBusy(user) });
  }));

  const bad = (res, error) => res.status(400).json({ error });

  router.post("/app/api/messages", sameSite, jsonOnly, wrap(async (req, res) => {
    const b = req.body;
    if (!b || typeof b !== "object" || Array.isArray(b)) return bad(res, "Send a message.");
    const account = req.account;
    const base = baseMessage(account.number);
    let shown;
    let message;
    if (b.tapId !== undefined) {
      const title = typeof b.tapTitle === "string" ? b.tapTitle.trim() : "";
      if (typeof b.tapId !== "string" || !b.tapId || b.tapId.length > MAX_TAP_FIELD) return bad(res, "That choice could not be read.");
      if (!title || title.length > MAX_TAP_FIELD) return bad(res, "That choice could not be read.");
      const reply = { id: b.tapId, title };
      if (b.data !== undefined) {
        let size = Infinity;
        try { size = JSON.stringify(b.data).length; } catch { /* stays too big */ }
        if (!(size <= (b.tapId === TABLE_TAP ? MAX_TABLE_DATA : MAX_TAP_DATA))) return bad(res, "That choice carries too much.");
        reply.data = b.data;
      }
      shown = title;
      message = { ...base, type: "interactive", interactive: { type: "button_reply", button_reply: reply } };
    } else {
      const text = typeof b.text === "string" ? b.text.trim() : "";
      if (!text) return bad(res, "Write a message first.");
      if (text.length > MAX_TEXT) return bad(res, `That message is too long. The limit is ${MAX_TEXT} characters.`);
      shown = text;
      message = { ...base, type: "text", text: { body: text } };
    }
    const seq = conversations.append(account.number, "user", "text", shown);
    handle(account, message);
    res.status(202).json({ seq, busy: true });
  }));

  // ---- uploads ----
  // The body is the file itself. A refusal waits for the rest of the body to go
  // by (discarded, up to twice the limit) before answering: a client that is still
  // sending when the reply arrives sees the connection reset and loses the reply.
  // The connection is closed afterwards, since the body may not have been read in full.
  const uploading = new Set(); // people whose file is still arriving: one at a time, and one buffer each
  const refuseUpload = async (req, res, status, error) => {
    await drain(req, maxUploadBytes * 2);
    return res.set("Connection", "close").status(status).json({ error });
  };

  router.post("/app/api/upload", sameSite, wrap(async (req, res) => {
    const account = req.account;
    const number = account.number;
    if (typeof req.query.name !== "string" || !req.query.name.trim()) return refuseUpload(req, res, 400, "Name the file.");
    const name = cleanFileName(req.query.name);
    // One file at a time: a second would replace the first while its message may still be waiting.
    if (uploads.has(number) || uploading.has(number)) return refuseUpload(req, res, 409, "Wait for the last file to finish first.");

    let body;
    uploading.add(number);
    try { body = await readLimited(req, maxUploadBytes); }
    catch { return; } // the client went away; nobody to answer
    finally { uploading.delete(number); }
    if (body.tooLarge) return refuseUpload(req, res, 413, MSG_TOO_LARGE);
    const kind = classifyUpload(name, body.buffer);
    if (!kind) return res.status(415).json({ error: MSG_BAD_TYPE });

    const id = uploads.put(number, { buffer: body.buffer, mediaType: kind.mime, name });
    const base = baseMessage(number);
    const message = kind.kind === "image"
      ? { ...base, type: "image", image: { id, mime_type: kind.mime } }
      : { ...base, type: "document", document: { id, filename: name, mime_type: kind.mime } };
    const seq = conversations.append(number, "user", "text", name);
    handle(account, message, () => uploads.remove(id));
    res.status(202).json({ seq, busy: true });
  }));

  // ---- files ----
  // A ref the person (or a share token's owner) may read, as { drive: file } or
  // { gen: { path, name } }; null for anything else, so every refusal looks alike.
  async function resolveRef(ref, user) {
    if (typeof ref !== "string") return null;
    const i = ref.indexOf(":");
    const kind = ref.slice(0, i);
    const id = ref.slice(i + 1);
    if (kind === "drive") {
      if (!DRIVE_ID.test(id)) return null;
      const file = await getFile(id);
      return file ? { drive: file } : null;
    }
    if (kind === "gen") {
      if (!UUID.test(id) || !user) return null;
      const found = webChannel.readGenerated(id, user);
      return found ? { gen: found } : null;
    }
    return null;
  }

  // A person who taps Open lands on this in a new tab: a short page, not raw
  // JSON. The page's own fetches (which never ask for HTML) still get JSON.
  const refuse = (req, res, status, text) => {
    res.set("Cache-Control", "no-store");
    if (String(req.headers && req.headers.accept || "").includes("text/html")) return res.status(status).type("html").send(notice(text));
    return res.status(status).json({ error: text });
  };
  const unavailable = (req, res) => refuse(req, res, 404, "That file is no longer available.");

  // Streams the file. Headers go out only once the source is open, so a source
  // that fails to open is a clean 502; one that dies later destroys the response.
  async function sendFile(req, res, found) {
    let source;
    let name;
    let type;
    let length = null;
    if (found.drive) {
      const f = found.drive;
      name = f.name;
      type = mimeFor(f.name, f.exportMime);
      try { source = f.exportMime ? await openExport(f.id, f.exportMime) : await openDrive(f.id); }
      catch (err) {
        console.error("Drive file could not be opened:", err && err.message);
        return refuse(req, res, 502, "That file could not be fetched right now. Try again.");
      }
      // No Content-Length for Drive files: the library's saved size goes stale when a
      // file is replaced in place, and a short length would cut the download off silently.
    } else {
      const g = found.gen;
      name = g.name;
      type = mimeFor(g.name);
      try { length = (await fs.promises.stat(g.path)).size; }
      catch { return unavailable(req, res); }
      source = fs.createReadStream(g.path);
    }
    const inline = req.query.inline === "1" && INLINE_OK.has(type);
    res.set({ "Content-Type": type, "Content-Disposition": contentDisposition(name, inline) });
    if (length !== null) res.set("Content-Length", String(length));
    // pipeline destroys the source when the client leaves and the response when the source fails.
    pipeline(source, res, (err) => {
      if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") console.error("File stream ended early:", err.message);
    });
  }

  router.get("/app/files/:ref", wrap(async (req, res) => {
    const found = await resolveRef(req.params.ref, req.account.number);
    if (!found) return unavailable(req, res);
    await sendFile(req, res, found);
  }));

  // ---- share links ----
  router.post("/app/api/share-link", sameSite, jsonOnly, wrap(async (req, res) => {
    const ref = req.body && typeof req.body === "object" ? req.body.ref : undefined;
    if (typeof ref !== "string") return bad(res, "Say which file to share.");
    if (!publicUrl || !secret) return res.status(503).json({ error: "Sharing is not set up." });
    const found = await resolveRef(ref, req.account.number);
    if (!found) return unavailable(req, res);
    const token = makeShareToken(ref, found.gen ? req.account.number : null, { secret, now });
    res.set("Cache-Control", "no-store").json({ url: `${String(publicUrl).replace(/\/+$/, "")}/s/${token}` });
  }));

  // Public: the link is the key. Nothing here is logged, and a bad or old link
  // gets the same short page whatever was wrong with it.
  router.get("/s/:token", wrap(async (req, res) => {
    const t = verifyShareToken(req.params.token, { secret, now });
    if (!t) return res.status(410).type("html").send(notice("This link has expired."));
    const found = await resolveRef(t.ref, t.owner);
    if (!found) return res.status(404).type("html").send(notice("That file is no longer available."));
    await sendFile(req, res, found);
  }));

  // ---- the screen ----
  // web/public holds the chat page with its script, styles, manifest and icons.
  // Closed like the rest of /app (mountWeb's sign-in check runs first), no
  // directory listing, and the policy header above covers these files too.
  router.use("/app", express.static(PUBLIC_DIR, {
    index: "index.html",
    dotfiles: "ignore",
    // Revalidate every time, so a new version of the page does not wait for a cache to expire.
    setHeaders: (res) => res.set("Cache-Control", "no-cache"),
  }));

  router.use(webErrorHandler);
  return router;
}

module.exports = { createWebRoutes, contentDisposition, webErrorHandler, CSP, MSG_TOO_LARGE, MSG_BAD_TYPE };
