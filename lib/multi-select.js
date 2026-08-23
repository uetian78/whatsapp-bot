// ============================================================
//  Parse a multi-document pick from a text reply.
//
//  WhatsApp's interactive list is SINGLE-select — one tap sends one
//  reply and closes the list, and the Cloud API has no multi-select
//  list type. So picking several documents happens by text: the bot
//  shows a numbered set and the user answers with any of
//
//     2            one document (what the bot already supported)
//     1,3,5        several
//     1 3 5        several, space separated
//     1-4          a range
//     1-3, 7       mixed
//     all          everything on offer
//
//  Returns null when the text isn't a selection at all, so the router
//  can fall through to normal message handling.
// ============================================================

const ALL_WORDS = /^(all|all files?|all documents?|send all|everything)$/i;

// A selection is only digits, ranges and separators — anything else (a word,
// a filename, a new question) is not a pick and must fall through.
const SELECTION_SHAPE = /^[\d\s,;.&-]+(and[\d\s,;.&-]+)*$/i;

function parseSelection(text, max, { cap = 10 } = {}) {
  const raw = String(text ?? "").trim();
  if (!raw || !Number.isInteger(max) || max < 1) return null;

  if (ALL_WORDS.test(raw)) {
    return { indices: range(0, Math.min(max, cap) - 1), invalid: [], all: true,
             capped: max > cap };
  }

  const normalized = raw.replace(/\band\b/gi, ",");
  if (!SELECTION_SHAPE.test(normalized)) return null;

  const tokens = normalized.split(/[\s,;.&]+/).filter(Boolean);
  if (!tokens.length) return null;

  const picked = [];
  const invalid = [];

  for (const token of tokens) {
    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      let [, from, to] = rangeMatch;
      from = parseInt(from, 10);
      to = parseInt(to, 10);
      if (from > to) [from, to] = [to, from];
      for (let n = from; n <= to; n++) pushPick(n);
      continue;
    }
    if (/^\d+$/.test(token)) { pushPick(parseInt(token, 10)); continue; }
    return null; // a stray "-" or "1a" — not a selection, let the router have it
  }

  function pushPick(n) {
    if (n < 1 || n > max) { if (!invalid.includes(n)) invalid.push(n); return; }
    const idx = n - 1;
    if (!picked.includes(idx)) picked.push(idx);
  }

  if (!picked.length && !invalid.length) return null;

  const indices = picked.sort((a, b) => a - b);
  const capped = indices.length > cap;
  return { indices: indices.slice(0, cap), invalid, all: false, capped };
}

function range(from, to) {
  const out = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

module.exports = { parseSelection };
