// ============================================================
//  Ordered intent table — the ONE place that encodes the webhook
//  router's dispatch order. crm.classify() consumes it; the
//  server.js if-chain follows the same order (see tests).
//  match(text) must be sync, cheap, and side-effect free.
// ============================================================
const { parseDatasheetRequest, buildSelectionInteractive, parseSeriesRequest, interpretCode } = require("./products.js");
const { routeChillerText } = require("./chillers.js");
const { parseListRequest } = require("./product-facts.js");
const { parseSplitListRequest } = require("./split-engine.js");
const { isMenuTrigger, smallTalkReply } = require("./menu.js");
const { isVrfTrigger } = require("./vrf/trigger.js");

const MENTIONS_DOC = /\b(datasheet|data ?sheet|catalog(?:ue)?|iom|manual|brochure|drawing|pdf|document|file)\b/i;
const QUESTION_WORDS = /\b(what|whats|what's|how many|how much|which|tell me|explain|compare|difference|capacity|cooling|airflow|eer|iplv|tonnage|weight|dimensions?|sound|dba|refrigerant)\b/i;

const safe = (fn) => (t) => { try { return fn(t); } catch (_) { return null; } };

const INTENTS = [
  { name: "media",              match: (t) => /^\[(image|document|audio|video|sticker)\]$/.test(t) },
  { name: "button-tap",         match: (t) => t.startsWith("btn:") },
  { name: "numbered-reply",     match: (t) => /^\d+$/.test(t) },
  { name: "menu",               match: (t) => isMenuTrigger(t) },
  { name: "vrf-selection",      match: (t) => isVrfTrigger(t) },
  { name: "schedule-selection", match: (t) => /^(image|boq|schedule)\s+selection$/i.test(t) },
  { name: "split-selection",    match: (t) => /^split\s+selection$/i.test(t) },
  { name: "mtz-selection",      match: (t) => /^mtz\s+selection$/i.test(t) },
  { name: "print",              match: (t) => /^(print|datasheet)$/i.test(t) },
  { name: "admin-stats",        match: (t) => /^stats$/i.test(t) },
  { name: "small-talk",         match: (t) => !!smallTalkReply(t) },
  { name: "split-list",         match: safe(parseSplitListRequest) },
  { name: "list-units",         match: safe(parseListRequest) },
  { name: "question",           match: (t) => !MENTIONS_DOC.test(t) && (/\?/.test(t) || QUESTION_WORDS.test(t)) },
  { name: "chiller",            match: safe(routeChillerText) },
  { name: "datasheet",          match: safe(parseDatasheetRequest) },
  { name: "selection",          match: safe(buildSelectionInteractive) },
  { name: "catalogue-iom",      match: safe(parseSeriesRequest) },
  { name: "model-code",         match: safe(interpretCode) },
  { name: "doc-search",         match: (t) => MENTIONS_DOC.test(t) },
];

function classify(text) {
  const t = (text || "").trim();
  if (!t) return "empty";
  for (const i of INTENTS) if (i.match(t)) return i.name;
  if (/\b(price|cost|warranty|deliver|contact|hours)\b/i.test(t)) return "question";
  return "other";
}

module.exports = { INTENTS, classify };
