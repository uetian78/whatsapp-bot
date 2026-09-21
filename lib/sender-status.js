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
const OUTSIDE_WINDOW_CODE = 131047;
const RANK = { pending: 0, sent: 1, delivered: 2, read: 3 };

function createStatusStore({ now = Date.now } = {}) {
  const entries = new Map(); // wamid -> { status, ts, code?, message?, outsideWindow? }

  function purge() {
    const t = now();
    for (const [id, e] of entries) if (t - e.ts > TTL_MS) entries.delete(id);
  }

  function track(id) {
    if (!id || entries.has(id)) return;
    entries.set(id, { status: "pending", ts: now() });
  }

  function record(event) {
    if (!event?.id || !event.status) return;
    purge();
    const prev = entries.get(event.id);
    if (!prev || prev.status === "failed") return;

    if (event.status === "failed") {
      const err = event.errors?.[0] || {};
      entries.set(event.id, {
        status: "failed",
        ts: prev.ts,
        code: err.code ?? null,
        message: err.error_data?.details || err.message || err.title || "Delivery failed",
        outsideWindow: err.code === OUTSIDE_WINDOW_CODE,
      });
      return;
    }
    const rank = RANK[event.status];
    if (rank === undefined || rank <= RANK[prev.status]) return;
    entries.set(event.id, { status: event.status, ts: prev.ts });
  }

  function get(id) {
    purge();
    return (id && entries.get(id)) || null;
  }

  return { track, record, get };
}

module.exports = { createStatusStore, OUTSIDE_WINDOW_CODE };
