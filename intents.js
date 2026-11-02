// ============================================================
//  Ordered intent table — the ONE place that encodes the webhook
//  router's dispatch order. crm.classify() consumes it; the
//  server.js if-chain follows the same order (see tests).
//  match(text) must be sync, cheap, and side-effect free.
// ============================================================
const { parseDatasheetRequest, buildSelectionInteractive, parseSeriesRequest, interpretCode } = require("./products.js");
const { routeChillerText } = require("./chillers.js");
const { parseListRequest } = require("./product-facts.js");
const { isMenuTrigger, smallTalkReply } = require("./menu.js");
const { isSearchAllTrigger, isAiSearchTrigger, stripFindVerb } = require("./lib/broad-search.js");

const MENTIONS_DOC = /\b(datasheet|data ?sheet|catalog(?:ue)?|iom|manual|brochure|drawing|pdf|document|file)\b/i;

const safe = (fn) => (t) => { try { return fn(t); } catch (_) { return null; } };

const INTENTS = [
  { name: "media",              match: (t) => /^\[(image|document|audio|video|sticker)\]$/.test(t) },
  { name: "button-tap",         match: (t) => t.startsWith("btn:") },
  { name: "numbered-reply",     match: (t) => /^\d+$/.test(t) },
  { name: "menu",               match: (t) => isMenuTrigger(t) },
  { name: "admin-stats",        match: (t) => /^stats$/i.test(t) },
  { name: "small-talk",         match: (t) => !!smallTalkReply(t) },
  { name: "search-all",         match: (t) => isSearchAllTrigger(t) },
  { name: "ai-search",          match: (t) => isAiSearchTrigger(t) },
  { name: "list-units",         match: safe(parseListRequest) },
  { name: "chiller",            match: safe(routeChillerText) },
  { name: "datasheet",          match: safe(parseDatasheetRequest) },
  { name: "selection",          match: safe(buildSelectionInteractive) },
  { name: "catalogue-iom",      match: safe(parseSeriesRequest) },
  { name: "model-code",         match: safe(interpretCode) },
  { name: "doc-search",         match: (t) => MENTIONS_DOC.test(t) },
];

// "find X" / "search X" is X typed without the verb, as in server.js, so it is
// classified as X. The checks that come before it in the router (a menu word,
// small talk, "search all", "ai search", a tap, a number) still win.
const BEFORE_FIND = new Set(["media", "button-tap", "numbered-reply", "menu", "admin-stats", "small-talk", "search-all", "ai-search"]);

function classify(text, depth = 0) {
  const t = (text || "").trim();
  if (!t) return "empty";
  for (const i of INTENTS) {
    if (!BEFORE_FIND.has(i.name)) break;
    if (i.match(t)) return i.name;
  }
  const rest = depth === 0 ? stripFindVerb(t) : null;
  if (rest) return classify(rest, depth + 1);
  for (const i of INTENTS) if (!BEFORE_FIND.has(i.name) && i.match(t)) return i.name;
  return "other";
}

module.exports = { INTENTS, classify };
