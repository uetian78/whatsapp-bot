// ============================================================
//  Files people attach in the web chat.
//
//  Held in memory only, one per person, for 15 minutes or until the message
//  that carries it has been handled. At most 32 MB each, so three people use
//  at most about 100 MB on a 0.5 GB plan. There is no timer: expired uploads are
//  dropped when the store is next touched, so the app can sleep.
//
//  Allowed: JPEG, PNG, WebP, PDF, XLSX, XLS, CSV. The type is decided by the
//  file name's ending AND the first bytes, so a renamed file is refused.
// ============================================================
const crypto = require("node:crypto");

const MAX_BYTES = 32 * 1024 * 1024;
const KEEP_MS = 15 * 60 * 1000;
const MAX_NAME = 120;

// ---- the store ----
// get(id) -> { buffer, mediaType } | null, the shape the web channel's
// downloadMedia hands to the handlers.
function createUploadStore({ now = Date.now, keepMs = KEEP_MS } = {}) {
  const byId = new Map(); // id -> { user, buffer, mediaType, name, expires }
  const byUser = new Map(); // user -> id
  const clock = () => (typeof now === "function" ? now() : now);

  function drop(id) {
    const e = byId.get(id);
    if (!e) return;
    byId.delete(id);
    if (byUser.get(e.user) === id) byUser.delete(e.user);
  }
  function sweep() {
    const t = clock();
    for (const [id, e] of byId) if (t >= e.expires) drop(id);
  }

  return {
    // The caller checks has(user) first; a second put for the same person
    // replaces the first.
    put(user, { buffer, mediaType, name }) {
      sweep();
      const u = String(user);
      if (byUser.has(u)) drop(byUser.get(u));
      const id = crypto.randomUUID();
      byId.set(id, { user: u, buffer, mediaType, name, expires: clock() + keepMs });
      byUser.set(u, id);
      return id;
    },
    get(id) {
      if (typeof id !== "string") return null;
      const e = byId.get(id);
      if (!e) return null;
      if (clock() >= e.expires) { drop(id); return null; }
      return { buffer: e.buffer, mediaType: e.mediaType };
    },
    has(user) {
      sweep();
      return byUser.has(String(user));
    },
    remove(id) { drop(id); },
  };
}

// ---- the name ----
// The last part of whatever path the browser sent, without anything that could
// break a header, a page or a path: controls, line and bidi characters, slashes
// and the characters Windows refuses. Never empty, at most 120 characters, and
// the ending is kept.
function cleanFileName(raw) {
  let s = String(raw ?? "").toWellFormed();
  s = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  s = s.split(/[\\/]/).pop();
  s = s.replace(/[<>:"|?*]/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "").trim();
  if (!s) return "upload";
  const chars = Array.from(s);
  if (chars.length > MAX_NAME) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : "";
    s = chars.slice(0, MAX_NAME - Array.from(ext).length).join("") + ext;
  }
  return s;
}

// ---- the type ----
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const starts = (buf, bytes) => buf.length >= bytes.length && buf.subarray(0, bytes.length).equals(bytes);

const TYPES = {
  jpg: { mime: "image/jpeg", kind: "image", ok: (b) => starts(b, Buffer.from([0xff, 0xd8, 0xff])) },
  jpeg: { mime: "image/jpeg", kind: "image", ok: (b) => starts(b, Buffer.from([0xff, 0xd8, 0xff])) },
  png: { mime: "image/png", kind: "image", ok: (b) => starts(b, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  webp: {
    mime: "image/webp", kind: "image",
    ok: (b) => b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
  },
  pdf: { mime: "application/pdf", kind: "document", ok: (b) => b.subarray(0, 1024).includes("%PDF-") },
  // A zip that holds a workbook. Any other zip (renamed to .xlsx) is refused.
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "document",
    ok: (b) => starts(b, Buffer.from([0x50, 0x4b, 0x03, 0x04])) && b.includes("xl/workbook.xml"),
  },
  xls: { mime: "application/vnd.ms-excel", kind: "document", ok: (b) => starts(b, OLE) },
  csv: { mime: "text/csv", kind: "document", ok: (b) => !b.includes(0) },
};

// { mime, kind } when the name's ending and the bytes agree, else null.
function classifyUpload(name, buffer) {
  if (!buffer || !buffer.length) return null;
  const dot = String(name).lastIndexOf(".");
  const type = dot >= 0 ? TYPES[String(name).slice(dot + 1).toLowerCase()] : null;
  if (!type || !type.ok(buffer)) return null;
  return { mime: type.mime, kind: type.kind };
}

// ---- reading the body ----
// Collects the request body up to `limit` bytes and never holds more. A body
// over the limit is read on and thrown away (up to twice the limit) rather than
// answered at once: a client that is still sending when the reply arrives sees
// the connection reset and loses the reply. Resolves { buffer } or
// { tooLarge: true }; rejects if the client goes away.
function readLimited(req, limit = MAX_BYTES) {
  const drainCap = limit * 2;
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (declared > drainCap) return resolve({ tooLarge: true });
    // With a declared length, allocate once and fill it: no second copy at the end.
    const exact = Number.isFinite(declared) && declared >= 0 && declared <= limit;
    const target = exact ? Buffer.allocUnsafe(declared) : null;
    const chunks = [];
    let size = 0;
    let seen = 0;
    let over = false;
    let done = false;
    const finish = (fn, value) => { if (!done) { done = true; fn(value); } };

    req.on("data", (chunk) => {
      seen += chunk.length;
      if (over) {
        if (seen > drainCap) finish(resolve, { tooLarge: true });
        return;
      }
      if (size + chunk.length > limit || (target && size + chunk.length > target.length)) {
        over = true;
        chunks.length = 0;
        if (seen > drainCap) finish(resolve, { tooLarge: true });
        return;
      }
      if (target) chunk.copy(target, size); else chunks.push(chunk);
      size += chunk.length;
    });
    req.on("end", () => {
      if (over) return finish(resolve, { tooLarge: true });
      finish(resolve, { buffer: target ? target.subarray(0, size) : Buffer.concat(chunks, size) });
    });
    req.on("error", (err) => finish(reject, err));
    req.on("aborted", () => finish(reject, new Error("The upload was cancelled")));
    req.on("close", () => { if (!req.complete) finish(reject, new Error("The upload was cancelled")); });
  });
}

// Reads and throws away what is still coming (up to `cap` bytes), so a refusal
// reaches a client that is still sending. Never rejects.
function drain(req, cap = MAX_BYTES * 2) {
  return new Promise((resolve) => {
    let seen = 0;
    const done = () => { req.removeAllListeners("data"); resolve(); };
    if (req.complete) return resolve();
    req.on("data", (chunk) => { seen += chunk.length; if (seen > cap) done(); });
    req.on("end", resolve);
    req.on("error", resolve);
    req.on("close", resolve);
  });
}

module.exports = { createUploadStore, cleanFileName, classifyUpload, readLimited, drain, MAX_BYTES, KEEP_MS };
