// ============================================================
//  "Request it" — when a user can't find a document, one tap asks
//  for it to be added to the HVAC Assistant library. The request is
//  logged to the CRM sheet's "Requests" tab (crm.logDocRequest) and
//  WhatsApped to the admin number(s). Pure helpers live here so they
//  can be tested without the Graph or Sheets APIs.
// ============================================================

const DEFAULT_ADMIN = "97466279059";
const DEDUPE_MS = 24 * 60 * 60 * 1000;
const CTX_KEY = "docreq";

// Reply button (title ≤ 20) and list row (title ≤ 24, description ≤ 72).
const REQUEST_BUTTON = { id: "docreq", title: "📥 Request (1-4 hrs)" };
const REQUEST_ROW = {
  id: "docreq",
  title: "📥 Request it (1-4 hrs)",
  description: "Not listed? Request it and get it within 1-4 hours",
};
const REQUEST_PROMPT =
  "📥 Can't find it? Tap *Request* and get it within 1-4 hours — we'll add it to the HVAC Assistant library.";

const digits = (s) => String(s || "").replace(/\D/g, "");

// Who gets the WhatsApp alert: ADMIN_NUMBERS when set, else the default admin.
function alertNumbers(env = process.env) {
  const list = String(env.ADMIN_NUMBERS || "").split(",").map(digits).filter(Boolean);
  return [...new Set(list.length ? list : [DEFAULT_ADMIN])];
}

// Requests tab: Time (Qatar) | Phone | Name | Requested | Status
function requestRow({ ts, from, name, query }) {
  return [ts, from, name || "", String(query || "").slice(0, 300), "Open"];
}

// One request per number + query per 24h, so repeat taps don't spam the
// admin or the sheet. In-memory, like session-store: a restart forgets.
function createDedupe(now = Date.now) {
  const seenAt = new Map();
  const key = (from, q) => `${from}|${String(q || "").toLowerCase().replace(/\s+/g, " ").trim()}`;
  return {
    seen(from, query) {
      const k = key(from, query);
      const t = seenAt.get(k);
      if (t !== undefined && now() - t <= DEDUPE_MS) return true;
      seenAt.set(k, now());
      return false;
    },
  };
}

function adminAlertText({ from, name, query }) {
  return (
    `📥 *Library request*\n` +
    `From: ${name ? `${name} ` : ""}(+${from})\n` +
    `Looking for: "${query}"\n\n` +
    `Logged in the CRM sheet → Requests tab.`
  );
}

function confirmText(query) {
  return `✅ Request sent — you'll get *"${query}"* within 1-4 hours. We're adding it to the HVAC Assistant library.`;
}

function duplicateText(query) {
  return `👍 *"${query}"* has already been requested — you'll get it within 1-4 hours.`;
}

module.exports = {
  CTX_KEY, DEDUPE_MS, REQUEST_BUTTON, REQUEST_ROW, REQUEST_PROMPT,
  alertNumbers, requestRow, createDedupe, adminAlertText, confirmText, duplicateText,
};
