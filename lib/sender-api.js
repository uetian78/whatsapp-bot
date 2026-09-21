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

function createSenderRouter({ pin, loadAccounts, polish, sendMessage, statusStore, now = Date.now }) {
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

  router.post("/send", async (req, res) => {
    const to = normalizeNumber(req.body?.to);
    const text = String(req.body?.text ?? "");
    if (to.length < MIN_DIGITS) return res.status(400).json({ error: "bad_number" });
    if (!text.trim()) return res.status(400).json({ error: "empty_text" });
    if (text.length > MAX_TEXT) return res.status(400).json({ error: "too_long" });
    const r = await sendMessage(to, text);
    if (!r.ok) {
      return res.status(502).json({
        ok: false, code: r.code ?? null, message: r.message || "Send failed",
        outsideWindow: r.code === OUTSIDE_WINDOW_CODE,
      });
    }
    if (!r.id) {
      return res.status(502).json({
        ok: false, code: null, message: "WhatsApp did not return a message id", outsideWindow: false,
      });
    }
    statusStore.track(r.id);
    res.json({ ok: true, id: r.id });
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
