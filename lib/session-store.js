// ============================================================
//  Unified per-user conversation state.
//  - flow: the ONE active guided flow (split / mtz / schedule).
//    Exclusive per user. Expiry is reported once ({expired,type})
//    so the router can send the right "session timed out" message.
//  - ctx:  named auxiliary state (open menu, numbered list, print
//    results, unit-list toggle). Keys coexist; expiry is silent.
//  The Maps are the working copy. persist(from) writes one user's flow and
//  ctx to SQLite (table user_state) and restore() reads them back at startup,
//  so a conversation survives a sleep or redeploy. Until persist/restore is
//  called the store never touches the database.
// ============================================================

const DEFAULT_TTL = 10 * 60 * 1000;

// An expired flow is kept (in memory, and in the saved rows through a restart)
// until it has been reported once, so a late reply still hears "session timed
// out" instead of falling into document search. Railway sleeps after about as
// long as a flow lives, so without this the restart would silently erase it.
// One that nobody ever came back to is dropped after this long, so it can't
// report weeks later.
const EXPIRED_FLOW_KEPT_MS = 24 * 60 * 60 * 1000;

// First JSON-unsafe thing in a value, as a short type name, or null if it
// round-trips as plain JSON. Buffers, Maps, Dates and functions would be saved
// as something else (or nothing), so they count as unsafe rather than being
// silently mangled. Never returns the value itself.
function unsafeType(v, path = new Set()) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "function" || t === "symbol" || t === "bigint") return t;
  if (t !== "object") return null;
  if (path.has(v)) return "circular reference";
  const proto = Object.getPrototypeOf(v);
  if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) {
    return (v.constructor && v.constructor.name) || "object";
  }
  path.add(v);
  try {
    for (const item of Array.isArray(v) ? v : Object.values(v)) {
      const bad = unsafeType(item, path);
      if (bad) return bad;
    }
  } finally { path.delete(v); }
  return null;
}

function createSessionStore({ db, now } = {}) {
  const clock = now || (() => Date.now()); // call-time lookup: a frozen Date.now is followed
  const flows = new Map(); // from -> { type, data, ts, ttl }
  const ctxs = new Map();  // from -> Map(key -> { data, ts, ttl })

  // The database is resolved on first persist/restore, never before.
  let handle = db || null;
  const database = () => handle || (handle = require("./db.js").getDb());

  function startFlow(from, type, data = {}, ttlMs = DEFAULT_TTL) {
    flows.set(from, { type, data, ts: clock(), ttl: ttlMs });
    return data;
  }

  function getFlow(from) {
    const f = flows.get(from);
    if (!f) return null;
    if (clock() - f.ts > f.ttl) {
      flows.delete(from);
      return { expired: true, type: f.type };
    }
    return f;
  }

  function touchFlow(from) {
    const f = flows.get(from);
    if (f) f.ts = clock();
  }

  function endFlow(from) {
    flows.delete(from);
  }

  function setCtx(from, key, data, ttlMs = DEFAULT_TTL) {
    let m = ctxs.get(from);
    if (!m) { m = new Map(); ctxs.set(from, m); }
    m.set(key, { data, ts: clock(), ttl: ttlMs });
    return data;
  }

  function getCtx(from, key) {
    const m = ctxs.get(from);
    const e = m && m.get(key);
    if (!e) return null;
    if (clock() - e.ts > e.ttl) { m.delete(key); return null; }
    return e.data;
  }

  function clearCtx(from, key) {
    const m = ctxs.get(from);
    if (m) m.delete(key);
  }

  // keep: ctx keys to leave in place (saved results that outlive a "menu").
  function clearAll(from, keep = []) {
    flows.delete(from);
    const m = ctxs.get(from);
    if (!m) return;
    for (const k of [...m.keys()]) if (!keep.includes(k)) m.delete(k);
    if (!m.size) ctxs.delete(from);
  }

  // Sweep dead entries so abandoned sessions don't accumulate forever.
  function sweep() {
    const t = clock();
    for (const [from, f] of flows) if (t - f.ts > f.ttl + EXPIRED_FLOW_KEPT_MS) flows.delete(from); // expired ones wait to be reported
    for (const [from, m] of ctxs) {
      for (const [k, e] of m) if (t - e.ts > e.ttl) m.delete(k);
      if (!m.size) ctxs.delete(from);
    }
  }

  // Replace this user's saved rows with their current live state. Handlers
  // mutate flow.data in place, so this is called after handling a message and
  // always writes what is in memory now. An entry that can't be saved as JSON
  // is skipped with a warning (key and type only, never the value) so one bad
  // value can't lose the rest of the user's state.
  function persist(from) {
    const t = clock();
    const entries = [];
    const add = (key, entry, record, kept = 0) => {
      if (t - entry.ts > entry.ttl + kept) return; // already dead
      const bad = unsafeType(entry.data);
      if (bad) {
        console.warn(`session-store: not saving "${key}" (${bad} is not JSON-safe)`);
        return;
      }
      entries.push([key, JSON.stringify(record), entry.ts + entry.ttl]);
    };
    const f = flows.get(from);
    if (f) add("flow", f, { type: f.type, data: f.data, ts: f.ts, ttl: f.ttl }, EXPIRED_FLOW_KEPT_MS);
    const m = ctxs.get(from);
    if (m) for (const [k, e] of m) add(`ctx:${k}`, e, { data: e.data, ts: e.ts, ttl: e.ttl });

    const d = database();
    d.exec("BEGIN");
    try {
      d.prepare("DELETE FROM user_state WHERE user = ?").run(from);
      const ins = d.prepare("INSERT INTO user_state (user, key, value, expires_at) VALUES (?, ?, ?, ?)");
      for (const [key, value, expiresAt] of entries) ins.run(from, key, value, expiresAt);
      d.exec("COMMIT");
    } catch (err) {
      d.exec("ROLLBACK");
      throw err;
    }
  }

  // Load saved state back into the Maps (call once at startup). Expired ctx
  // rows are deleted and not brought back. Expired flow rows stay for
  // EXPIRED_FLOW_KEPT_MS, so getFlow can still say the session timed out (and
  // then the next persist drops the row). Unreadable rows are dropped. A
  // schedule flow caught mid-read ("processing") restarts at "awaitImage": the
  // read died with the process.
  function restore() {
    const d = database();
    const t = clock();
    d.prepare("DELETE FROM user_state WHERE (key <> 'flow' AND expires_at < ?) OR (key = 'flow' AND expires_at < ?)")
      .run(t, t - EXPIRED_FLOW_KEPT_MS);
    const bad = [];
    for (const row of d.prepare("SELECT user, key, value FROM user_state").all()) {
      try {
        const rec = JSON.parse(row.value);
        if (row.key === "flow") {
          if (rec.type === "schedule" && rec.data && rec.data.step === "processing") rec.data.step = "awaitImage";
          flows.set(row.user, { type: rec.type, data: rec.data, ts: rec.ts, ttl: rec.ttl });
        } else if (row.key.startsWith("ctx:")) {
          let m = ctxs.get(row.user);
          if (!m) { m = new Map(); ctxs.set(row.user, m); }
          m.set(row.key.slice(4), { data: rec.data, ts: rec.ts, ttl: rec.ttl });
        } else {
          bad.push(row);
        }
      } catch (_) {
        bad.push(row);
      }
    }
    for (const row of bad) d.prepare("DELETE FROM user_state WHERE user = ? AND key = ?").run(row.user, row.key);
  }

  return { startFlow, getFlow, touchFlow, endFlow, setCtx, getCtx, clearCtx, clearAll, sweep, persist, restore, DEFAULT_TTL };
}

// The module's own exports work on one default store.
const store = createSessionStore();

const SWEEP_MS = 5 * 60 * 1000;
const sweeper = setInterval(store.sweep, SWEEP_MS);
if (sweeper.unref) sweeper.unref();

module.exports = { ...store, createSessionStore };
