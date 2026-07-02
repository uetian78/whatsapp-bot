// ============================================================
//  Unified per-user conversation state.
//  - flow: the ONE active guided flow (split / mtz / schedule).
//    Exclusive per user. Expiry is reported once ({expired,type})
//    so the router can send the right "session timed out" message.
//  - ctx:  named auxiliary state (open menu, numbered list, print
//    results, unit-list toggle). Keys coexist; expiry is silent.
//  All state is in-memory: it does not survive a restart, matching
//  the pre-existing behavior of the 8 stores this replaces.
// ============================================================

const DEFAULT_TTL = 10 * 60 * 1000;

const flows = new Map(); // from -> { type, data, ts, ttl }
const ctxs = new Map();  // from -> Map(key -> { data, ts, ttl })

function startFlow(from, type, data = {}, ttlMs = DEFAULT_TTL) {
  flows.set(from, { type, data, ts: Date.now(), ttl: ttlMs });
  return data;
}

function getFlow(from) {
  const f = flows.get(from);
  if (!f) return null;
  if (Date.now() - f.ts > f.ttl) {
    flows.delete(from);
    return { expired: true, type: f.type };
  }
  return f;
}

function touchFlow(from) {
  const f = flows.get(from);
  if (f) f.ts = Date.now();
}

function endFlow(from) {
  flows.delete(from);
}

function setCtx(from, key, data, ttlMs = DEFAULT_TTL) {
  let m = ctxs.get(from);
  if (!m) { m = new Map(); ctxs.set(from, m); }
  m.set(key, { data, ts: Date.now(), ttl: ttlMs });
  return data;
}

function getCtx(from, key) {
  const m = ctxs.get(from);
  const e = m && m.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > e.ttl) { m.delete(key); return null; }
  return e.data;
}

function clearCtx(from, key) {
  const m = ctxs.get(from);
  if (m) m.delete(key);
}

function clearAll(from) {
  flows.delete(from);
  ctxs.delete(from);
}

// Sweep dead entries so abandoned sessions don't accumulate forever.
const SWEEP_MS = 5 * 60 * 1000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [from, f] of flows) if (now - f.ts > f.ttl) flows.delete(from);
  for (const [from, m] of ctxs) {
    for (const [k, e] of m) if (now - e.ts > e.ttl) m.delete(k);
    if (!m.size) ctxs.delete(from);
  }
}, SWEEP_MS);
if (sweeper.unref) sweeper.unref();

module.exports = { startFlow, getFlow, touchFlow, endFlow, setCtx, getCtx, clearCtx, clearAll, DEFAULT_TTL };
