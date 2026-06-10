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

// 1 ton refrigeration = 3.51685 kW (matches products.js TR_KW).
const KW_PER_TR = 3.51685;
const round2 = (n) => Math.round(n * 100) / 100;

// Convert a capacity value to kW given a unit hint (the unit field and/or the
// raw capacity text — a cell may read "2 TR"). Schedules vary: TR/tons, kW,
// BTU/h, MBH, kcal/h. Unknown/empty unit -> assume kW (prior default; most VRF
// schedules are kW). The engine selects indoor units by required_kw, so getting
// this right is what prevents a TR value being sized as if it were kW.
// Returns { kw, unit } where unit is the normalized label for display.
function capacityToKw(value, unitHint) {
  const v = parseFloat(value);
  if (isNaN(v)) return { kw: NaN, unit: null };
  const u = String(unitHint || '').toLowerCase();
  if (/\btr\b|ton/.test(u)) return { kw: round2(v * KW_PER_TR), unit: 'TR' };
  if (/mbh|kbtu/.test(u))   return { kw: round2(v * 0.293071), unit: 'MBH' };
  if (/btu/.test(u))        return { kw: round2(v / 3412.142), unit: 'BTU/h' };
  if (/kcal/.test(u))       return { kw: round2(v / 859.845), unit: 'kcal/h' };
  return { kw: v, unit: 'kW' };
}

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
        '`type | capacity | qty | system | room`',
        'e.g. `4 way cassette | 5 | 1 | S1 | Office`',
        'Capacity is kW by default — write e.g. `2 TR` if your schedule is in tons.',
        '',
        'Only type and capacity are required. Send *done* when finished.',
      ].join('\n');
    default:
      return '';
  }
}

function parseRowLine(line) {
  const p = line.split('|').map((s) => s.trim());
  const capStr = p[1] || '';
  const conv = capacityToKw(parseFloat(capStr), capStr); // capStr carries any unit text (e.g. "2 TR")
  if (!p[0] || isNaN(conv.kw)) return null;
  return {
    type: p[0],
    required_kw: conv.kw,
    qty: p[2] ? parseInt(p[2], 10) || 1 : 1,
    system: p[3] || 'S1',
    room: p[4] || '',
    tag: null, // engine/build will tag IU-01..n
    _srcValue: parseFloat(capStr),
    _srcUnit: conv.unit,
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
  const cKw = col(/required|load|capacity|kw|\btr\b|ton|btu|mbh|kcal/);
  const cQty = col(/qty|quantity|nos|no\./);
  const cSys = col(/system|grp|group/);
  const cRoom = col(/room|area|tag|location/);

  // The capacity column's unit comes from its header text (e.g. "Capacity (TR)").
  const kwHeader = cKw >= 0 ? header[cKw] : '';

  const rows = [];
  if (cKw < 0) return rows;
  for (let i = hdrIdx + 1; i < grid.length; i++) {
    const r = grid[i];
    const cellVal = r[cKw];
    // Unit from the header OR the cell itself (a cell may read "2 TR").
    const conv = capacityToKw(parseFloat(cellVal), `${kwHeader} ${typeof cellVal === 'string' ? cellVal : ''}`);
    if (isNaN(conv.kw)) continue;
    rows.push({
      type: cType >= 0 ? String(r[cType] || '') : '',
      required_kw: conv.kw,
      qty: cQty >= 0 ? (parseInt(r[cQty], 10) || 1) : 1,
      system: cSys >= 0 ? String(r[cSys] || 'S1') : 'S1',
      room: cRoom >= 0 ? String(r[cRoom] || '') : '',
      tag: null,
      _srcValue: parseFloat(cellVal),
      _srcUnit: conv.unit,
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
    '{"type": <indoor unit type text exactly as written>,',
    ' "capacity": <the cooling capacity NUMBER exactly as printed>,',
    ' "unit": <the capacity unit EXACTLY as printed: "kW", "TR", "ton", "BTU/h", "MBH", "kcal/h"; "" if none shown>,',
    ' "qty": <integer, default 1>, "system": <system/group id or "S1">,',
    ' "room": <room/area/tag text or "">}',
    'Copy the capacity value and its unit EXACTLY; do NOT convert or round.',
    'The unit is critical: if the schedule shows TR or tons, put "TR" in unit —',
    'do NOT assume kW. If a row has no system grouping, use "S1". Do not invent',
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
    .map((r) => {
      if (!r) return null;
      // Prefer capacity+unit (new schema); fall back to legacy required_kw (kW).
      let conv, srcValue;
      if (r.capacity !== undefined && r.capacity !== null && r.capacity !== '') {
        const hint = `${r.unit || ''} ${typeof r.capacity === 'string' ? r.capacity : ''}`;
        conv = capacityToKw(parseFloat(r.capacity), hint);
        srcValue = parseFloat(r.capacity);
      } else {
        conv = { kw: parseFloat(r.required_kw), unit: 'kW' };
        srcValue = parseFloat(r.required_kw);
      }
      if (isNaN(conv.kw)) return null;
      return {
        type: String(r.type || ''),
        required_kw: conv.kw,
        qty: parseInt(r.qty, 10) || 1,
        system: String(r.system || 'S1'),
        room: String(r.room || ''),
        tag: null,
        _srcValue: isNaN(srcValue) ? null : srcValue,
        _srcUnit: conv.unit,
      };
    })
    .filter(Boolean);

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
  // show up to 8 rows so the user can eyeball them. When the source was not kW
  // (e.g. TR), show the conversion so a unit misread is caught before building.
  rows.slice(0, 8).forEach((r, i) => {
    const cap = (r._srcUnit && r._srcUnit !== 'kW' && r._srcValue != null && !isNaN(r._srcValue))
      ? `${r._srcValue} ${r._srcUnit} → ${r.required_kw} kW`
      : `${r.required_kw} kW`;
    lines.push(`${i + 1}. ${r.system} | ${r.type || '(type?)'} | ${cap} x${r.qty} | ${r.room || ''}`.trim());
  });
  if (rows.length > 8) lines.push(`...and ${rows.length - 8} more.`);
  lines.push('', 'Reply *yes* to build the BOQ, or *no* to cancel and send a clearer file.');
  return lines.join('\n');
}

module.exports = {
  startGuided, guidedPrompt, guidedStep,
  rowsFromWorkbook, rowsFromImageOrPdf,
  extractionConfirmText, capacityToKw,
};
