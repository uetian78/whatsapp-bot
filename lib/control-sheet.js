// ============================================================
//  The Google Sheet is the control panel. Two tabs are read (the old "Rules"
//  keyword tab is not; it can stay in the Sheet):
//   1) "Knowledge" -> Topic | Info          (the AI's knowledge base)
//   2) "Allowed"   -> Number | Name | Plan  (who may use the bot and the web app)
//  The Allowed tab is the gate: a number that isn't on it gets no reply, and an
//  empty tab lets nobody in.
//
//  Read at most once a minute. If a refresh fails, the last good copy is kept
//  and served; with no copy at all it throws, and callers decide what that means
//  (the bot says nothing, the web app answers 503).
// ============================================================
const google = require("./google.js");
const { parseAccounts } = require("./accounts.js");

const CACHE_MS = 60 * 1000; // refresh at most once per minute
const RETRY_MS = 15 * 1000; // after a failed refresh, wait this long before asking again

// Everything the outside world touches is injected so a test can drive it. The
// defaults look the Sheets client and the sheet id up at call time (not at
// require time): nothing here reads the environment or the network on require,
// and a replaced google.getSheets (the replay harness does that) is honoured.
function createLoadSheet({
  getSheets = () => google.getSheets(),
  sheetId = () => process.env.GOOGLE_SHEET_ID,
  now = Date.now,
  cacheMs = CACHE_MS,
  retryMs = RETRY_MS,
  log = console.log,
} = {}) {
  let last = null;       // last good copy: { knowledge, allowed, accounts }
  let freshUntil = 0;    // until then `last` is served without asking the Sheet
  let inflight = null;   // callers arriving mid-refresh share it

  async function refresh() {
    const sheets = await getSheets();
    // Allowed is A2:C: A = number, B = name, C = plan. The plan is parsed but
    // gates nothing. Rows that only fill A keep working.
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: sheetId(),
      ranges: ["Knowledge!A2:B", "Allowed!A2:C"],
    });
    const [knowRows, allowRows] = res.data.valueRanges.map((r) => r.values || []);

    const knowledge = knowRows
      .filter((r) => r[0] || r[1])
      .map((r) => `${r[0] ? r[0] + ": " : ""}${r[1] || ""}`);

    // `accounts` carries name + plan per number; `allowed` is the same numbers
    // as a plain list.
    const accounts = parseAccounts(allowRows);
    const allowed = [...accounts.keys()];

    last = { knowledge, allowed, accounts };
    freshUntil = now() + cacheMs;
    log(`🔄 Sheet loaded: ${knowledge.length} knowledge rows, ${accounts.size} account(s)`);
    return last;
  }

  return async function loadSheet() {
    if (last && now() < freshUntil) return last;
    if (!inflight) {
      inflight = refresh()
        .catch((err) => {
          if (!last) throw err; // nothing saved: the caller has to know
          freshUntil = now() + retryMs;
          console.error(`Sheet refresh failed, using the last good copy: ${err.message}`);
          return last;
        })
        .finally(() => { inflight = null; });
    }
    return inflight;
  };
}

const loadSheet = createLoadSheet();

module.exports = { loadSheet, createLoadSheet };
