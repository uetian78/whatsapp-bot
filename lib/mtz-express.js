// ============================================================
//  The one-line MTZ command: "MTZ Selection 8.5TR 80/67/115".
//  Pure; server.js starts the usual MTZ steps from what this returns, and the
//  MTZ engine is not touched. null for anything that is not a clear command, so
//  the caller falls back to the guided steps (as a bare "MTZ Selection" does).
//
//  The load is whatever comes before the conditions; the conditions are the LAST
//  three numbers: dry bulb °F, wet bulb °F, outdoor ambient °F. 1 TR = 12 MBH.
// ============================================================
const TR_TO_MBH = 12;

// The same ranges the guided "conditions" step accepts.
const LIMITS = { db: [60, 100], wb: [50, 85], amb: [70, 135] };

const NUMBER = /\d+(?:\.\d+)?/g;
const COMMAND = /^\s*mtz\s+selection\b/i;
const LOAD = /^(\d+(?:\.\d+)?)\s*(tr|tons?|mbh|mbtu\/h|mbtuh)?$/i;

// "8.5TR", "8.5 tons", "102 MBH", "102" -> MBH. A bare number is MBH, as in the
// guided steps. Any other unit (kW, BTU...) is not guessed at: null.
function loadToMbh(text) {
  const m = LOAD.exec(String(text).trim());
  if (!m) return null;
  const v = parseFloat(m[1]);
  const tons = m[2] && /^(tr|ton)/i.test(m[2]);
  const mbh = tons ? v * TR_TO_MBH : v;
  return Number.isFinite(mbh) && mbh > 0 ? mbh : null;
}

// The guided "cooling load" step: "8.5 TR", "100 MBH", "100", "8.5TR / 7TR".
// The same units as the shortcut and nothing else: kW and BTU/h are refused,
// never converted or read as MBH ("100 kW" taken as 100 MBH would be a silent
// capacity error). Returns { tc, sc } in MBH (sc null without a usable
// sensible load), or { error: "unit" } for a number with a unit we don't take,
// or { error: "read" } for anything else.
function parseLoadReply(text) {
  const parts = String(text).replace(/mbtu\/h/gi, "mbh").split(/[,\/|]+/);
  const failure = (part) => {
    const unit = /^\s*\d+(?:\.\d+)?\s*([a-z][a-z/]*)/i.exec(part);
    return { error: unit && !/^(tr|tons?|mbh|mbtuh)$/i.test(unit[1]) ? "unit" : "read" };
  };
  const tc = loadToMbh(parts[0]);
  if (tc === null) return failure(parts[0]);
  let sc = null;
  if (parts[1] !== undefined && parts[1].trim()) {
    const v = loadToMbh(parts[1]);
    if (v === null) return failure(parts[1]);
    if (v < tc) sc = v; // a sensible load above the total is ignored
  }
  return { tc, sc };
}

function parseMtzExpress(text) {
  if (typeof text !== "string") return null;
  const head = COMMAND.exec(text);
  if (!head) return null;
  const rest = text.slice(head[0].length);
  // "8,5TR" is not 8 MBH with a sensible load: a comma between digits is not read at all.
  if (/\d,\d/.test(rest)) return null;

  const found = [...rest.matchAll(NUMBER)];
  if (found.length < 4) return null; // a load and three conditions, at least
  const [db, wb, amb] = found.slice(-3).map((m) => parseFloat(m[0]));
  if (!(db >= LIMITS.db[0] && db <= LIMITS.db[1])) return null;
  if (!(wb >= LIMITS.wb[0] && wb <= LIMITS.wb[1]) || wb > db) return null;
  if (!(amb >= LIMITS.amb[0] && amb <= LIMITS.amb[1])) return null;

  // Everything before the conditions is the load: "8.5TR" or "8.5TR / 7TR".
  const loadText = rest.slice(0, found[found.length - 3].index);
  const parts = loadText.split(/[,\/|]+/);
  const reqTC = loadToMbh(parts[0]);
  if (reqTC === null) return null;
  if (parts.length > 2 && parts.slice(2).some((p) => p.trim())) return null;
  let reqSC = null;
  if (parts[1] !== undefined && parts[1].trim()) {
    const sc = loadToMbh(parts[1]);
    if (sc === null) return null;
    if (sc < reqTC) reqSC = sc; // a sensible load above the total is ignored, as in the guided steps
  }
  return { reqTC, reqSC, db, wb, amb };
}

module.exports = { parseMtzExpress, parseLoadReply, loadToMbh, TR_TO_MBH, LIMITS };
