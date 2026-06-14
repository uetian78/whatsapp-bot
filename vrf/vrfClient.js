// vrfClient.js — CommonJS. Calls the VRF sidecar, returns { xlsxBuffer, summary }.
//
// Env vars expected on the Node bot service:
//   VRF_SIDECAR_URL   e.g. https://vrf-sidecar.onrender.com
//   VRF_API_KEY       same secret set on the sidecar
//
// Node 18+ has global fetch. If on older Node, require('node-fetch').

// Co-hosted by default: the VRF engine runs in the same container on
// 127.0.0.1:8000 (see root Dockerfile). Override with VRF_SIDECAR_URL only if
// you run the engine as a separate service again.
const VRF_SIDECAR_URL = process.env.VRF_SIDECAR_URL || "http://127.0.0.1:8000";
const VRF_API_KEY = process.env.VRF_API_KEY;

// Render free-tier services spin down after ~15 min idle; the first request
// then cold-starts (~15-50s) and the edge returns 502/503/504 until the app is
// up. Strategy (free-tier friendly — we do NOT keep it warm 24/7, which would
// burn the account's free instance-hours and risk suspension): let it sleep,
// but WAIT for it to wake (poll /health) before POSTing /select, so a user's
// selection is never lost to a cold-start 502. The /select POST keeps a short
// retry as a final safety net once the service reports healthy.
const RETRY_STATUSES = new Set([502, 503, 504]);
const RETRY_DELAYS_MS = [2000, 4000, 8000];  // 3 retries on the (now-warm) POST
const REQUEST_TIMEOUT_MS = 30000;            // per /select attempt
const HEALTH_TIMEOUT_MS = 70000;             // Render holds a cold GET /health during boot
const READY_BUDGET_MS = 150000;              // total time we'll wait for the engine to wake
const PROGRESS_EVERY_MS = 10000;             // heartbeat the user every 10s while waiting

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One /health GET. Resolves true on HTTP 200, false otherwise. Throws on
// timeout/network error (caller decides whether to keep waiting).
async function pingHealth(timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${VRF_SIDECAR_URL}/health`, { method: 'GET', signal: ctrl.signal });
    return res.ok;
  } finally {
    clearTimeout(t);
  }
}

// Best-effort wake-up ping. Call when a VRF session starts so the cold boot
// begins early and the service is usually warm by confirm time. Never throws.
async function warmUpSidecar() {
  if (!VRF_SIDECAR_URL) return;
  try { await pingHealth(HEALTH_TIMEOUT_MS); } catch (_) { /* best-effort */ }
}

// One-shot diagnostic probe (used by GET /vrf-health on the bot): which URL is
// the client pointed at, and does /health answer? Never throws.
async function sidecarProbe() {
  const started = Date.now();
  try {
    const ok = await pingHealth(10000);
    return { engineUrl: VRF_SIDECAR_URL, ok, ms: Date.now() - started };
  } catch (e) {
    const error = e.name === "AbortError" ? "timeout (no answer in 10s)" : e.message;
    return { engineUrl: VRF_SIDECAR_URL, ok: false, error, ms: Date.now() - started };
  }
}

// Block until the sidecar answers /health with 200 (it cold-starts on the free
// tier). Render holds a cold GET during boot, so a single ping often returns
// 200 after ~15-30s; we also re-poll in case the edge 502s a request mid-boot.
// `onProgress(seconds)` (optional) is invoked every PROGRESS_EVERY_MS on a timer
// so the user keeps getting a "still working" heartbeat even while a health
// check is held open. Returns true once healthy, false if it never wakes.
async function waitForSidecarReady(budgetMs = READY_BUDGET_MS, onProgress, heartbeatMs = PROGRESS_EVERY_MS) {
  if (!VRF_SIDECAR_URL) return false;
  const start = Date.now();
  const deadline = start + budgetMs;

  let hb = null;
  if (typeof onProgress === 'function') {
    hb = setInterval(() => {
      Promise.resolve(onProgress(Math.round((Date.now() - start) / 1000))).catch(() => {});
    }, heartbeatMs);
    if (hb.unref) hb.unref(); // don't keep the process alive for this timer
  }

  try {
    while (Date.now() < deadline) {
      try {
        const timeout = Math.max(5000, Math.min(HEALTH_TIMEOUT_MS, deadline - Date.now()));
        if (await pingHealth(timeout)) return true;
      } catch (_) { /* timeout/network during boot -> keep waiting */ }
      if (Date.now() < deadline) await sleep(Math.min(3000, deadline - Date.now()));
    }
    return false;
  } finally {
    if (hb) clearInterval(hb);
  }
}

/**
 * @param {Object} input
 * @param {string} input.project
 * @param {number} [input.discount]   0.25 etc; omit for engine default
 * @param {Array}  input.rows         [{tag, system, room, type, required_kw, qty}]
 * @returns {Promise<{xlsxBuffer: Buffer, summary: Object}>}
 */
async function runVrfSelection(input, onProgress) {
  if (!VRF_SIDECAR_URL || !VRF_API_KEY) {
    throw new Error('VRF_SIDECAR_URL / VRF_API_KEY not configured');
  }
  if (!input || !Array.isArray(input.rows) || input.rows.length === 0) {
    throw new Error('input.rows must be a non-empty array');
  }

  // Free-tier sidecar may be asleep. Wait for it to wake BEFORE POSTing, so the
  // selection isn't lost to a cold-start 502. onProgress heartbeats the user.
  const ready = await waitForSidecarReady(READY_BUDGET_MS, onProgress);
  if (!ready) {
    throw new Error('the selection engine is not responding. Please try again in a minute — if it keeps failing, ask the admin to check /vrf-health.');
  }

  const body = JSON.stringify({
    project: input.project || 'VRF Project',
    discount: input.discount, // undefined is fine; JSON drops it
    rows: input.rows,
  });

  const maxAttempts = RETRY_DELAYS_MS.length + 1;
  let lastTransient = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      try {
        res = await fetch(`${VRF_SIDECAR_URL}/select`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': VRF_API_KEY },
          body,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      // network error / timeout (cold start hang) -> transient, retry
      lastTransient = e.name === 'AbortError' ? 'request timed out' : e.message;
      if (attempt < maxAttempts - 1) { await sleep(RETRY_DELAYS_MS[attempt]); continue; }
      throw new Error(`sidecar unreachable after ${maxAttempts} tries (${lastTransient}). It may be asleep or down — try again in a minute.`);
    }

    // 502/503/504 from Render's edge -> service waking/unavailable, retry
    if (RETRY_STATUSES.has(res.status)) {
      lastTransient = `status ${res.status}`;
      if (attempt < maxAttempts - 1) { await sleep(RETRY_DELAYS_MS[attempt]); continue; }
      throw new Error(`sidecar not responding after ${maxAttempts} tries (${lastTransient}). It may be asleep or down — try again in a minute, or check the sidecar service.`);
    }

    // Any other non-OK (400 engine error, 401 auth, etc.) is a real error: do not retry.
    if (!res.ok) {
      let detail = '';
      try { detail = JSON.stringify(await res.json()); } catch (_) {}
      throw new Error(`sidecar ${res.status}: ${detail}`);
    }

    const summaryHeader = res.headers.get('x-summary');
    const summary = summaryHeader ? JSON.parse(summaryHeader) : {};
    const arrayBuf = await res.arrayBuffer();
    return { xlsxBuffer: Buffer.from(arrayBuf), summary };
  }

  // Unreachable, but keep the contract explicit.
  throw new Error(`sidecar selection failed (${lastTransient || 'unknown'})`);
}

/**
 * Raw text/CSV path — pass a pasted schedule directly to the engine.
 * Returns { xlsxBuffer, summary, warnings, excluded }.
 */
async function runVrfFromText(project, rawText, discount, onProgress) {
  if (!VRF_SIDECAR_URL || !VRF_API_KEY) {
    throw new Error('VRF_SIDECAR_URL / VRF_API_KEY not configured');
  }
  if (!rawText || !rawText.trim()) {
    throw new Error('rawText is empty');
  }

  const ready = await waitForSidecarReady(READY_BUDGET_MS, onProgress);
  if (!ready) {
    throw new Error('the selection engine is not responding. Please try again in a minute.');
  }

  const body = JSON.stringify({
    project: project || 'VRF Project',
    discount: discount != null ? discount : 0.25,
    raw_text: rawText,
  });

  const maxAttempts = RETRY_DELAYS_MS.length + 1;
  let lastTransient = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      try {
        res = await fetch(`${VRF_SIDECAR_URL}/select-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': VRF_API_KEY },
          body,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      lastTransient = e.name === 'AbortError' ? 'request timed out' : e.message;
      if (attempt < maxAttempts - 1) { await sleep(RETRY_DELAYS_MS[attempt]); continue; }
      throw new Error(`sidecar unreachable after ${maxAttempts} tries (${lastTransient}).`);
    }

    if (RETRY_STATUSES.has(res.status)) {
      lastTransient = `status ${res.status}`;
      if (attempt < maxAttempts - 1) { await sleep(RETRY_DELAYS_MS[attempt]); continue; }
      throw new Error(`sidecar not responding after ${maxAttempts} tries (${lastTransient}).`);
    }

    if (!res.ok) {
      let detail = '';
      try { detail = JSON.stringify(await res.json()); } catch (_) {}
      throw new Error(`sidecar ${res.status}: ${detail}`);
    }

    const metaHeader = res.headers.get('x-meta');
    const meta = metaHeader ? JSON.parse(metaHeader) : {};
    const arrayBuf = await res.arrayBuffer();
    return {
      xlsxBuffer: Buffer.from(arrayBuf),
      summary: meta.summary || {},
      warnings: meta.warnings || [],
      excluded: meta.excluded || [],
    };
  }

  throw new Error(`sidecar selection failed (${lastTransient || 'unknown'})`);
}

/**
 * Build the tight WhatsApp reply text from the engine summary.
 * Keep it short — colleagues read this on a phone.
 */
function summaryToWhatsApp(summary, driveLink) {
  const tr = (kw) => (kw / 3.517).toFixed(1); // kW -> TR
  const lines = [
    `*${summary.project}* — VRF selection ready`,
    ``,
    `Systems: ${summary.systems}`,
    `Indoor units: ${summary.total_indoor_units}  (${summary.total_indoor_kw} kW)`,
    `Outdoor units: ${summary.total_outdoor_units}  (T3 ${summary.total_outdoor_kw_t3} kW / ${tr(summary.total_outdoor_kw_t3)} TR)`,
    `Models used: ${summary.models_used}`,
    `Discount: ${Math.round((summary.discount || 0) * 100)}%`,
  ];

  // Container loading (if engine returned it)
  const cl = summary.container_loading;
  if (cl && cl.containers_required != null) {
    const driverLabels = {
      odu_floor: 'ODU floor lanes',
      idu_volume: 'IDU volume',
      weight: 'weight',
    };
    const driver = driverLabels[cl.governing_driver] || cl.governing_driver;
    lines.push(``, `📦 *Container Loading (${cl.container || "40'HC"})*`);
    lines.push(`Containers required: *${cl.containers_required}*  _(governed by ${driver})_`);
    lines.push(`ODU modules: ${cl.odu_modules}  |  Indoor units: ${cl.idu_units}  |  Total weight: ${cl.total_weight_kg} kg`);
    if (cl.unknown_models && cl.unknown_models.length) {
      lines.push(`⚠️ No dims for: ${cl.unknown_models.join(', ')} (excluded from loading calc)`);
    }
  }

  if (summary.flags && summary.flags.length) {
    lines.push(``, `⚠️ *Flags:* ${summary.flags.join('; ')}`);
  }
  if (driveLink) {
    lines.push(``, `BOQ: ${driveLink}`);
  }
  lines.push(``, `_(Open the Prices tab to fill unit prices — totals repopulate automatically. See Container Loading tab for shipping details.)_`);
  return lines.join('\n');
}

module.exports = { runVrfSelection, runVrfFromText, summaryToWhatsApp, warmUpSidecar, waitForSidecarReady, sidecarProbe };
