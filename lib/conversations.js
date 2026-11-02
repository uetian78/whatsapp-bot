// ============================================================
//  Saved web conversations: one row per chat message, kept in SQLite so a
//  user's history survives the app sleeping and waking.
//  - append(user, role, kind, body) -> seq. role is "user" | "bot"; kind is
//    text | choices | file | pages | rowcheck | note.
//  - since(user, afterSeq, limit) -> the user's messages after that seq,
//    oldest first. seq is per database and only goes up.
//  - latest(user, limit) -> the user's newest messages, oldest first: what the
//    chat shows when it opens.
//  - savedWork(user, limit) -> the newest file messages (Drive and generated),
//    one per file: showing saved work again re-appends the cards, and those
//    copies must not count as more files (nor push real ones out of the limit).
//  - isEmpty(user) -> true when the user has no messages yet.
//  text and note bodies are plain strings; every other kind is stored as JSON
//  and comes back as an object, so callers never parse anything.
// ============================================================

const SAVED_PAGE = 100; // file rows read at a time by savedWork

const PLAIN_KINDS = new Set(["text", "note"]);

function encodeBody(kind, body) {
  return PLAIN_KINDS.has(kind) ? String(body ?? "") : JSON.stringify(body ?? null);
}

function toMessage(row) {
  let body = row.body;
  if (!PLAIN_KINDS.has(row.kind)) {
    try { body = JSON.parse(row.body); } catch { /* keep the raw string */ }
  }
  return { seq: Number(row.seq), role: row.role, kind: row.kind, body, ts: Number(row.ts) };
}

function createConversations({ db, now = Date.now }) {
  const insert = db.prepare("INSERT INTO messages (user, role, kind, body, ts) VALUES (?, ?, ?, ?, ?)");
  const after = db.prepare("SELECT seq, role, kind, body, ts FROM messages WHERE user = ? AND seq > ? ORDER BY seq ASC LIMIT ?");
  const newest = db.prepare("SELECT seq, role, kind, body, ts FROM messages WHERE user = ? ORDER BY seq DESC LIMIT ?");
  const files = db.prepare("SELECT seq, role, kind, body, ts FROM messages WHERE user = ? AND kind = 'file' AND seq < ? ORDER BY seq DESC LIMIT ?");
  const any = db.prepare("SELECT 1 AS found FROM messages WHERE user = ? LIMIT 1");

  return {
    db, // the web channel keeps its generated_files rows in the same database
    append(user, role, kind, body) {
      const res = insert.run(String(user), role, kind, encodeBody(kind, body), now());
      return Number(res.lastInsertRowid);
    },
    since(user, afterSeq = 0, limit = 200) {
      return after.all(String(user), Number(afterSeq) || 0, limit).map(toMessage);
    },
    latest(user, limit = 200) {
      return newest.all(String(user), limit).reverse().map(toMessage);
    },
    savedWork(user, limit = 10) {
      const seen = new Set();
      const out = [];
      let before = Number.MAX_SAFE_INTEGER;
      // Newest first, a page at a time, until there are enough different files.
      while (out.length < limit) {
        const rows = files.all(String(user), before, SAVED_PAGE);
        if (!rows.length) break;
        for (const row of rows) {
          const m = toMessage(row);
          const ref = m.body && typeof m.body === "object" ? m.body.ref : null;
          if (ref != null) {
            if (seen.has(ref)) continue;
            seen.add(ref);
          }
          out.push(m);
          if (out.length === limit) break;
        }
        before = Number(rows[rows.length - 1].seq);
      }
      return out;
    },
    isEmpty(user) {
      return !any.get(String(user));
    },
  };
}

module.exports = { createConversations };
