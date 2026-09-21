// ============================================================
//  Delivery status of messages sent from the Bot Sender app.
//
//  The Cloud API accepts a free-form message (HTTP 200 + wamid)
//  even when the recipient is outside the 24-hour window; the
//  rejection (code 131047) only arrives later as a webhook
//  `statuses` event. The webhook feeds this store and the app
//  polls /api/sender/status/:id for the outcome.
//
//  Only ids the sender tracked are kept — every bot reply also
//  produces statuses and we don't want to hold those.
// ============================================================
const TTL_MS = 60 * 60 * 1000;
// A webhook `statuses` event can beat the /send response that would have
// called track() — the Graph API sometimes fires the webhook before its own
// HTTP response finishes. record() on an id we haven't tracked yet keeps the
// event as a short-lived "early" entry so a track() that follows shortly
// after adopts it instead of clobbering it back to "pending". Untracked ids
// that are never track()'d (i.e. every bot reply, which also produces
// statuses) age out after EARLY_TTL_MS so they don't pile up.
const EARLY_TTL_MS = 60 * 1000;
const OUTSIDE_WINDOW_CODE = 131047;
const RANK = { pending: 0, sent: 1, delivered: 2, read: 3 };

function createStatusStore({ now = Date.now } = {}) {
  const entries = new Map(); // wamid -> { status, ts, code?, message?, outsideWindow?, early? }

  function purge() {
    const t = now();
    for (const [id, e] of entries) {
      const ttl = e.early ? EARLY_TTL_MS : TTL_MS;
      if (t - e.ts > ttl) entries.delete(id);
    }
  }

  function track(id) {
    if (!id) return;
    purge();
    const prev = entries.get(id);
    if (!prev) {
      entries.set(id, { status: "pending", ts: now() });
      return;
    }
    if (prev.early) {
      // Adopt the early event as the tracked entry (drop the `early` marker
      // so it behaves like any other tracked status from here on).
      const { early, ...rest } = prev;
      entries.set(id, rest);
    }
    // else: already tracked, leave it alone.
  }

  function record(event) {
    if (!event?.id || !event.status) return;
    purge();
    const prev = entries.get(event.id);

    if (!prev) {
      // Not tracked (yet, or ever). Stash it as an early event rather than
      // dropping it, in case track() is on its way.
      if (event.status === "failed") {
        const err = event.errors?.[0] || {};
        entries.set(event.id, {
          status: "failed",
          ts: now(),
          early: true,
          code: err.code ?? null,
          message: err.error_data?.details || err.message || err.title || "Delivery failed",
          outsideWindow: err.code === OUTSIDE_WINDOW_CODE,
        });
        return;
      }
      if (RANK[event.status] === undefined) return;
      entries.set(event.id, { status: event.status, ts: now(), early: true });
      return;
    }

    if (prev.status === "failed") return;

    if (event.status === "failed") {
      const err = event.errors?.[0] || {};
      entries.set(event.id, {
        status: "failed",
        ts: prev.ts,
        ...(prev.early ? { early: true } : {}),
        code: err.code ?? null,
        message: err.error_data?.details || err.message || err.title || "Delivery failed",
        outsideWindow: err.code === OUTSIDE_WINDOW_CODE,
      });
      return;
    }
    const rank = RANK[event.status];
    if (rank === undefined || rank <= RANK[prev.status]) return;
    entries.set(event.id, { status: event.status, ts: prev.ts, ...(prev.early ? { early: true } : {}) });
  }

  function get(id) {
    purge();
    const e = id && entries.get(id);
    if (!e || e.early) return null;
    return e;
  }

  return { track, record, get };
}

module.exports = { createStatusStore, OUTSIDE_WINDOW_CODE };
