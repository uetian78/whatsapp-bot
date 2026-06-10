// vrfIntake.js — CommonJS. Two ways to produce engine `rows` for the WhatsApp bot.
//
//   1) Guided flow      -> users type rows; you maintain per-user session state.
//   2) File extraction  -> image/PDF goes to Claude vision -> rows JSON.
//                          xlsx is parsed directly (no Claude, deterministic).
//
// After EITHER path you get rows -> pass to runVrfSelection() in vrfClient.js.
//
// Env vars:
//   ANTHROPIC_API_KEY   (only needed for image/PDF extraction)

const XLSX = require('xlsx'); // npm i xlsx  (SheetJS) — used for xlsx intake

// ---------------------------------------------------------------------------
// 1) GUIDED FLOW
// ---------------------------------------------------------------------------
// Minimal state machine. Plug into your existing per-user session store.
// State: { project, discount, rows:[], stage }
//
// One row line format users type:  type | required_kw | qty | system | room
//   e.g.  4 way cassette | 5.0 | 1 | S1 | Office 1
// Only type and required_kw are mandatory; rest default.

function startGuided() {
  return {
    project: null, discount: null, rows: [], stage: 'project',
  };
}

function guidedPrompt(stage) {
  switch (stage) {
    case 'project':
      return 'Project name?';
    case 'rows':
      return [
        'Send each unit on one line:',
        '`type | kW | qty | system | room`',
        'e.g. `4 way cassette | 5 | 1 | S1 | Office`',
        '',
        'Only type and kW are required. Send *done* when finished.',
      ].join('\n');
    default:
      return '';
  }
}

function parseRowLine(line) {
  const p = line.split('|').map((s) => s.trim());
  const required_kw = parseFloat(p[1]);
  if (!p[0] || isNaN(required_kw)) return null;
  return {
    type: p[0],
    required_kw,
    qty: p[2] ? parseInt(p[2], 10) || 1 : 1,
    system: p[3] || 'S1',
    room: p[4] || '',
    tag: null, // engine/build will tag IU-01..n
  };
}

// Feed each inbound WhatsApp message here. Returns {reply, done, session}.
function guidedStep(session, text) {
  const msg = (text || '').trim();
  if (session.stage === 'project') {
    session.project = msg || 'VRF Project';
    session.stage = 'rows';
    return { reply: guidedPrompt('rows'), done: false, session };
  }
  if (session.stage === 'rows') {
    if (/^done$/i.test(msg)) {
      if (session.rows.length === 0) {
        return { reply: 'No rows yet. Add at least one, then send *done*.', done: false, session };
      }
      return { reply: null, done: true, session };
    }
    const row = parseRowLine(msg);
    if (!row) {
      return { reply: 'Could not read that line. Format: `type | kW | qty | system | room`', done: false, session };
    }
    session.rows.push(row);
    return { reply: `Added (${session.rows.length}). Next line, or *done*.`, done: false, session };
  }
  return { reply: 'Type *vrf* to start.', done: false, session };
}

// ---------------------------------------------------------------------------
// 2a) XLSX / CSV INTAKE — deterministic, no Claude.
// ---------------------------------------------------------------------------
// Expects columns containing (case-insensitive) any of:
//   type, required/load/kw, qty/quantity, system, room/tag/area
function rowsFromWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
  if (!grid.length) return [];

  // find header row
  let hdrIdx = grid.findIndex((r) =>
    r.some((c) => typeof c === 'string' && /type|kw|load|room|system/i.test(c)));
  if (hdrIdx < 0) hdrIdx = 0;
  const header = grid[hdrIdx].map((c) => String(c || '').toLowerCase());

  const col = (re) => header.findIndex((h) => re.test(h));
  const cType = col(/type/);
  const cKw = col(/required|load|kw|capacity/);
  const cQty = col(/qty|quantity|nos|no\./);
  const cSys = col(/system|grp|group/);
  const cRoom = col(/room|area|tag|location/);

  const rows = [];
  for (let i = hdrIdx + 1; i < grid.length; i++) {
    const r = grid[i];
    const kw = cKw >= 0 ? parseFloat(r[cKw]) : NaN;
    if (isNaN(kw)) continue;
    rows.push({
      type: cType >= 0 ? String(r[cType] || '') : '',
      required_kw: kw,
      qty: cQty >= 0 ? (parseInt(r[cQty], 10) || 1) : 1,
      system: cSys >= 0 ? String(r[cSys] || 'S1') : 'S1',
      room: cRoom >= 0 ? String(r[cRoom] || '') : '',
      tag: null,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 2b) IMAGE / PDF INTAKE — Claude vision turns a schedule photo into rows.
// ---------------------------------------------------------------------------
// This is the ONE step that needs Claude. It only EXTRACTS data; the
// deterministic engine still does all selection.
//
// Model is configurable. Default is Sonnet 4.6: a VRF schedule feeds an
// engineering BOQ, so transcription accuracy matters more than cost, and Haiku
// misreads degraded photos / dense AutoCAD layouts. Override per-path
// (VRF_EXTRACT_MODEL_IMAGE / VRF_EXTRACT_MODEL_PDF) or globally
// (VRF_EXTRACT_MODEL) back to Haiku for known-clean schedules.
const MODEL_GLOBAL = process.env.VRF_EXTRACT_MODEL || null;
const MODEL_IMAGE = process.env.VRF_EXTRACT_MODEL_IMAGE || MODEL_GLOBAL || 'claude-sonnet-4-6';
const MODEL_PDF = process.env.VRF_EXTRACT_MODEL_PDF || MODEL_GLOBAL || 'claude-sonnet-4-6';

// Returns { rows, model }. rows already sanitized. The handler shows a
// confirmation (count of units/systems) before running the engine, so a
// misread surfaces to the user regardless of which model was used.
async function rowsFromImageOrPdf(base64Data, mediaType) {
  const isPdf = mediaType === 'application/pdf';
  const model = isPdf ? MODEL_PDF : MODEL_IMAGE;
  const block = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } };

  const prompt = [
    'You are extracting an HVAC equipment schedule. Return ONLY a JSON array,',
    'no prose, no markdown fences. Each element:',
    '{"type": <indoor unit type text exactly as written>, "required_kw": <number>,',
    ' "qty": <integer, default 1>, "system": <system/group id or "S1">,',
    ' "room": <room/area/tag text or "">}',
    'Use the cooling capacity in kW for required_kw. Copy values exactly; do not',
    'round or convert. If a row has no system grouping, use "S1". Do not invent',
    'rows. If you cannot confidently read a value, OMIT that row rather than',
    'guessing. Return [] if no schedule is present.',
  ].join(' ');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      messages: [{ role: 'user', content: [block, { type: 'text', text: prompt }] }],
    }),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch (_) {}
    throw new Error(`extraction API ${res.status}: ${detail}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .replace(/```json|```/g, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new Error('Could not parse schedule from the file. Try a clearer photo or send xlsx.');
  }
  if (!Array.isArray(parsed)) throw new Error('Extractor did not return a list.');

  const rows = parsed
    .filter((r) => r && !isNaN(parseFloat(r.required_kw)))
    .map((r) => ({
      type: String(r.type || ''),
      required_kw: parseFloat(r.required_kw),
      qty: parseInt(r.qty, 10) || 1,
      system: String(r.system || 'S1'),
      room: String(r.room || ''),
      tag: null,
    }));

  return { rows, model };
}

// Build a short confirmation message from extracted rows so the user can catch
// a misread before the engine runs. Counts units (qty-weighted) and systems.
function extractionConfirmText(rows) {
  const totalUnits = rows.reduce((n, r) => n + (r.qty || 1), 0);
  const systems = new Set(rows.map((r) => r.system || 'S1'));
  const totalKw = rows.reduce((s, r) => s + r.required_kw * (r.qty || 1), 0);
  const lines = [
    `I read *${rows.length}* line items — *${totalUnits}* units across *${systems.size}* system(s), total ${totalKw.toFixed(1)} kW.`,
    '',
  ];
  // show up to 8 rows so the user can eyeball them
  rows.slice(0, 8).forEach((r, i) => {
    lines.push(`${i + 1}. ${r.system} | ${r.type || '(type?)'} | ${r.required_kw} kW x${r.qty} | ${r.room || ''}`.trim());
  });
  if (rows.length > 8) lines.push(`...and ${rows.length - 8} more.`);
  lines.push('', 'Reply *yes* to build the BOQ, or *no* to cancel and send a clearer file.');
  return lines.join('\n');
}

module.exports = {
  startGuided, guidedPrompt, guidedStep,
  rowsFromWorkbook, rowsFromImageOrPdf,
  extractionConfirmText,
};
