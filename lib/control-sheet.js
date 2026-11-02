// ============================================================
//  The Google Sheet is the control panel. One tab is read (the old "Rules" and
//  "Knowledge" tabs are not; they can stay in the Sheet):
//   "Allowed" -> Number | Name | Plan  (who may use the bot and the web app)
//  The Allowed tab is the gate: a number that isn't on it gets no reply, and an
//  empty tab lets nobody in.
//
//  Read at most once a minute. A copy older than a minute is still served at
//  once while one refresh runs in the background, so a slow or hung Sheet can't
//  hold up file streams and polls. Only a copy older than MAX_STALE_MS (the
//  first request after a quiet spell) is waited for. So a person removed from
//  the Allowed tab loses access about a minute after the app is in use, and
//  within MAX_STALE_MS even after a lull, while the Sheet is healthy.
//  A refresh that fails or takes longer than TIMEOUT_MS keeps the last copy; with
//  no copy at all it throws, and callers decide what that means (the bot says
//  nothing, the web app answers 503).
// ============================================================
const google = require("./google.js");
const { parseAccounts } = require("./accounts.js");

const CACHE_MS = 60 * 1000; // refresh at most once per minute
const RETRY_MS = 15 * 1000; // after a failed refresh, wait this long before asking again
const MAX_STALE_MS = 2 * 60 * 1000; // an older copy is waited for, not served
const TIMEOUT_MS = 8 * 1000; // a Sheets call that takes longer than this has failed

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
  maxStaleMs = MAX_STALE_MS,
  timeoutMs = TIMEOUT_MS,
  log = console.log,
} = {}) {
  let last = null;       // last good copy: { allowed, accounts }
  let loadedAt = 0;      // when `last` was read
  let freshUntil = 0;    // until then `last` is served without asking the Sheet
  let degraded = false;  // the last refresh failed: serve `last`, never wait on a sick Sheet
  let inflight = null;   // callers arriving mid-refresh share it

  async function read(signal) {
    const sheets = await getSheets();
    // Allowed is A2:C: A = number, B = name, C = plan. The plan is parsed but
    // gates nothing. Rows that only fill A keep working.
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: sheetId(),
      ranges: ["Allowed!A2:C"],
    }, { signal });
    const [allowRows] = res.data.valueRanges.map((r) => r.values || []);

    // `accounts` carries name + plan per number; `allowed` is the same numbers
    // as a plain list.
    const accounts = parseAccounts(allowRows);
    const allowed = [...accounts.keys()];
    return { allowed, accounts };
  }

  // One read, given up on after timeoutMs. The abandoned call is told to stop
  // and its answer, if it ever comes, is ignored.
  function refresh() {
    const ctrl = new AbortController();
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new Error(`The Sheet did not answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
    });
    const reading = read(ctrl.signal);
    reading.catch(() => {}); // a read that loses the race may still fail later
    return Promise.race([reading, limit]).finally(() => clearTimeout(timer)).then((copy) => {
      last = copy;
      loadedAt = now();
      freshUntil = loadedAt + cacheMs;
      degraded = false;
      log(`🔄 Sheet loaded: ${copy.accounts.size} account(s)`);
      return last;
    });
  }

  function start() {
    if (!inflight) {
      inflight = refresh()
        .catch((err) => {
          if (!last) throw err; // nothing saved: the caller has to know
          degraded = true;
          freshUntil = now() + retryMs;
          console.error(`Sheet refresh failed, using the last good copy: ${err.message}`);
          return last;
        })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  return async function loadSheet() {
    if (last && now() < freshUntil) return last;
    const refreshing = start();
    if (last && (degraded || now() - loadedAt < maxStaleMs)) return last; // refreshing in the background
    return refreshing;
  };
}

const loadSheet = createLoadSheet();

module.exports = { loadSheet, createLoadSheet };
