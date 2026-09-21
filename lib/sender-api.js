// ============================================================
//  /api/sender — backend for the "Bot Sender" Android app, which
//  lets the owner message any number FROM the bot's WhatsApp
//  number. Anyone holding the PIN can speak as the bot, so every
//  route is locked behind X-Sender-Pin, and the whole router is
//  off unless SENDER_PIN is set.
//
//  Dependencies are injected so the router is testable without
//  Google Sheets, Anthropic or Meta.
// ============================================================
const express = require("express");
const crypto = require("node:crypto");
const { normalizeNumber } = require("./accounts.js");
const { OUTSIDE_WINDOW_CODE } = require("./sender-status.js");

const MAX_TEXT = 4096;
const MIN_DIGITS = 8;
const LANGUAGES = new Set(["en", "ar"]);
const MAX_ATTACHMENTS = 5;
// Must match WHATSAPP_MAX_FILE_BYTES in lib/wa.js (WhatsApp's own Graph API
// limit) — kept as a separate literal here rather than imported so this
// DI-only router stays free of any direct require on wa.js (which pulls in
// env-var-dependent code and would weaken this file's test isolation).
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 20;

// {kind:"library", id} or {kind:"upload", mediaId, name}. Extra/null fields
// on the object are ignored; only the shape for the given kind matters.
function isValidAttachment(a) {
  if (!a || typeof a !== "object") return false;
  if (a.kind === "library") return typeof a.id === "string" && a.id.length > 0;
  if (a.kind === "upload") return typeof a.mediaId === "string" && a.mediaId.length > 0 && typeof a.name === "string" && a.name.length > 0;
  return false;
}

// Brute-force protection on the PIN. This is a GLOBAL counter (not per-IP —
// the Render proxy in front of us makes req.ip unreliable, so per-IP limits
// are trivially bypassed). After MAX_PIN_FAILURES wrong PINs, every request
// is locked out for LOCKOUT_MS, including ones bearing the correct PIN.
const MAX_PIN_FAILURES = 20;
const LOCKOUT_MS = 15 * 60 * 1000;

function pinMatches(expected, given) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(given || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSenderRouter({
  pin, loadAccounts, polish, sendMessage, statusStore, now = Date.now,
  searchFiles, findFileById, uploadDriveFile, uploadStream, sendDocument,
}) {
  const router = express.Router();
  router.use(express.json());

  let failures = 0;
  let lockedUntil = 0;

  router.use((req, res, next) => {
    if (!pin) return res.status(503).json({ error: "sender_disabled" });
    if (now() < lockedUntil) return res.status(429).json({ error: "locked" });
    if (!pinMatches(pin, req.get("X-Sender-Pin"))) {
      failures += 1;
      if (failures >= MAX_PIN_FAILURES) {
        lockedUntil = now() + LOCKOUT_MS;
        failures = 0;
      }
      return res.status(401).json({ error: "bad_pin" });
    }
    failures = 0;
    next();
  });

  router.get("/contacts", async (req, res) => {
    try {
      const accounts = await loadAccounts();
      const label = (c) => (c.name || c.number).toLowerCase();
      const contacts = [...accounts.values()]
        .map((a) => ({ number: a.number, name: a.name || "" }))
        .sort((x, y) => label(x).localeCompare(label(y)));
      res.json({ contacts });
    } catch (err) {
      res.status(502).json({ error: "sheet_unavailable", message: err.message });
    }
  });

  router.post("/polish", async (req, res) => {
    const text = String(req.body?.text ?? "").trim();
    const language = req.body?.language ?? "en";
    const instruction = String(req.body?.instruction ?? "").trim();
    if (!text) return res.status(400).json({ error: "empty_text" });
    if (!LANGUAGES.has(language)) return res.status(400).json({ error: "bad_language" });
    const result = await polish({ text, language, instruction });
    if (!result.ok) return res.status(503).json({ error: "ai_unavailable", message: result.message });
    res.json({ draft: result.draft });
  });

  router.get("/files", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return res.status(400).json({ error: "empty_query" });
    try {
      const files = await searchFiles(q);
      res.json({ files: files.slice(0, MAX_SEARCH_RESULTS) });
    } catch (err) {
      res.status(502).json({ error: "drive_unavailable", message: err.message });
    }
  });

  router.post("/upload", async (req, res) => {
    let name;
    try {
      name = decodeURIComponent(req.get("X-File-Name") || "");
    } catch {
      return res.status(400).json({ error: "bad_file_name" });
    }
    name = name.split(/[\\/]/).pop() || "";
    if (!name) return res.status(400).json({ error: "bad_file_name" });

    const lenHeader = req.get("Content-Length");
    const length = Number(lenHeader);
    if (!lenHeader || !Number.isFinite(length) || length <= 0) {
      return res.status(411).json({ error: "length_required" });
    }
    if (length > MAX_UPLOAD_BYTES) {
      // Respond without reading the body — the connection is dropped, the
      // upload never streams to Graph.
      return res.status(413).json({ error: "too_large" });
    }

    // A phone client can vanish mid-upload (app killed, connection dropped,
    // user cancels). Without this, the outbound Graph request sits waiting
    // on a stream that will never produce more bytes until uploadMediaStream's
    // own 10-minute axios timeout — tying up the Render process the whole
    // time. Abort the outbound request the moment the inbound one dies.
    res.on("error", () => {}); // writing to an already-dead socket must never crash the process
    const controller = new AbortController();
    let aborted = false;
    function onDisconnect() {
      if (aborted) return;
      aborted = true;
      controller.abort();
    }
    const onClose = () => { if (!req.complete) onDisconnect(); };
    req.once("aborted", onDisconnect);
    req.once("close", onClose);
    function stopWatching() {
      req.removeListener("aborted", onDisconnect);
      req.removeListener("close", onClose);
    }

    try {
      const mediaId = await uploadStream(req, name, length, controller.signal);
      stopWatching();
      res.json({ mediaId, name });
    } catch (err) {
      stopWatching();
      if (aborted) {
        console.error(`Bot Sender upload aborted (client disconnected): ${name}`);
        if (!res.headersSent) res.status(400).json({ error: "upload_aborted" });
        return;
      }
      res.status(502).json({ error: "upload_failed", message: err.message });
    }
  });

  router.post("/send", async (req, res) => {
    const to = normalizeNumber(req.body?.to);
    const text = String(req.body?.text ?? "");
    const rawAttachments = req.body?.attachments;

    if (to.length < MIN_DIGITS) return res.status(400).json({ error: "bad_number" });

    let attachments = [];
    if (rawAttachments !== undefined && rawAttachments !== null) {
      if (!Array.isArray(rawAttachments)) return res.status(400).json({ error: "bad_attachment" });
      if (rawAttachments.length > MAX_ATTACHMENTS) return res.status(400).json({ error: "too_many_attachments" });
      attachments = rawAttachments;
    }
    for (const a of attachments) {
      if (!isValidAttachment(a)) return res.status(400).json({ error: "bad_attachment" });
    }

    // Resolve every library id up front, before sending anything — a PIN
    // holder must never be able to fetch a Drive file outside the bot's
    // indexed library, and a partial send (text gone, files unresolved)
    // would be worse than rejecting the whole request.
    const resolved = [];
    for (const a of attachments) {
      if (a.kind === "library") {
        const file = await findFileById(a.id);
        if (!file) return res.status(400).json({ error: "unknown_file" });
        resolved.push({ type: "library", file });
      } else {
        resolved.push({ type: "upload", mediaId: a.mediaId, name: a.name });
      }
    }

    if (!text.trim() && attachments.length === 0) return res.status(400).json({ error: "empty_text" });
    if (text.length > MAX_TEXT) return res.status(400).json({ error: "too_long" });

    const ids = [];

    // Reports a send result: tracks + records the id on success, or builds
    // the 502 body (with everything already sent) on failure.
    async function trackSend(sendPromise, failedItem) {
      const r = await sendPromise;
      if (!r.ok) {
        return {
          ok: false, code: r.code ?? null, message: r.message || "Send failed",
          outsideWindow: r.code === OUTSIDE_WINDOW_CODE, failedItem, ids: [...ids],
        };
      }
      if (!r.id) {
        return {
          ok: false, code: null, message: "WhatsApp did not return a message id",
          outsideWindow: false, failedItem, ids: [...ids],
        };
      }
      statusStore.track(r.id);
      ids.push(r.id);
      return null;
    }

    if (text.trim()) {
      const failure = await trackSend(sendMessage(to, text), "message");
      if (failure) return res.status(502).json(failure);
    }

    for (const item of resolved) {
      const name = item.type === "library" ? item.file.name : item.name;
      let mediaId = item.type === "upload" ? item.mediaId : null;
      if (item.type === "library") {
        try {
          mediaId = await uploadDriveFile(item.file);
        } catch (err) {
          const message = err.response?.status === 413
            ? "File is larger than WhatsApp's 100 MB limit"
            : `Couldn't fetch ${name} from the library`;
          return res.status(502).json({
            ok: false, code: null, message, outsideWindow: false, failedItem: name, ids: [...ids],
          });
        }
      }
      const failure = await trackSend(sendDocument(to, mediaId, name), name);
      if (failure) return res.status(502).json(failure);
    }

    res.json({ ok: true, id: ids[0], ids });
  });

  router.get("/status/:id", (req, res) => {
    const entry = statusStore.get(req.params.id);
    if (!entry) return res.status(404).json({ status: "unknown" });
    const { ts, ...rest } = entry;
    res.json(rest);
  });

  return router;
}

module.exports = { createSenderRouter };
