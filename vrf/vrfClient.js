// vrfClient.js — CommonJS. Calls the VRF sidecar, returns { xlsxBuffer, summary }.
//
// Env vars expected on the Node bot service:
//   VRF_SIDECAR_URL   e.g. https://vrf-sidecar.onrender.com
//   VRF_API_KEY       same secret set on the sidecar
//
// Node 18+ has global fetch. If on older Node, require('node-fetch').

const VRF_SIDECAR_URL = process.env.VRF_SIDECAR_URL;
const VRF_API_KEY = process.env.VRF_API_KEY;

/**
 * @param {Object} input
 * @param {string} input.project
 * @param {number} [input.discount]   0.25 etc; omit for engine default
 * @param {Array}  input.rows         [{tag, system, room, type, required_kw, qty}]
 * @returns {Promise<{xlsxBuffer: Buffer, summary: Object}>}
 */
async function runVrfSelection(input) {
  if (!VRF_SIDECAR_URL || !VRF_API_KEY) {
    throw new Error('VRF_SIDECAR_URL / VRF_API_KEY not configured');
  }
  if (!input || !Array.isArray(input.rows) || input.rows.length === 0) {
    throw new Error('input.rows must be a non-empty array');
  }

  const res = await fetch(`${VRF_SIDECAR_URL}/select`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': VRF_API_KEY,
    },
    body: JSON.stringify({
      project: input.project || 'VRF Project',
      discount: input.discount, // undefined is fine; JSON drops it
      rows: input.rows,
    }),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch (_) {}
    throw new Error(`sidecar ${res.status}: ${detail}`);
  }

  const summaryHeader = res.headers.get('x-summary');
  const summary = summaryHeader ? JSON.parse(summaryHeader) : {};
  const arrayBuf = await res.arrayBuffer();
  const xlsxBuffer = Buffer.from(arrayBuf);

  return { xlsxBuffer, summary };
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
  if (summary.flags && summary.flags.length) {
    lines.push(``, `Flags: ${summary.flags.join('; ')}`);
  }
  if (driveLink) {
    lines.push(``, `BOQ: ${driveLink}`);
  }
  lines.push(``, `(Open the Prices tab to fill unit prices — totals repopulate automatically.)`);
  return lines.join('\n');
}

module.exports = { runVrfSelection, summaryToWhatsApp };
