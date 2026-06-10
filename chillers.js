// chillers.js — SKM APCY-E / APCY-H air-cooled chiller knowledge base + selection engine
// Slots into the existing WhatsApp bot (server.js / products.js / catalogue-map.js pattern).
// Data: 65 models extracted verbatim from SKM datasheets ACH/2025/R1 (29 Oct 2025).
// Design basis for ALL ratings: 114.8°F (46°C) T3 ambient, 44/54°F LWT/EWT, R-134a, AHRI 550/590 (I-P).
// SAFETY RULE: never fabricate or interpolate a capacity/EER/sound/electrical value.
//             Only return numbers that exist in DB. If a model/code is not found, say so.

'use strict';
const DB = require('./chiller-db.json');
const MODELS = DB.models;

// ---- config (mirrors products.js conventions) ----
const SIZEUP_TOLERANCE = 0.05;        // 5% show-both rule
const SERIES = ['APCY-E', 'APCY-H'];
// Datasheet subfolders in Drive (add to catalogue-map DATASHEET_FOLDERS too)
const DATASHEET_FOLDERS = {
  'APCY-E': 'APCY-E Datasheets',
  'APCY-H': 'APCY-H Datasheets'
};
// Drive datasheet filename pattern (confirm exact names on Drive before go-live):
//   e.g. "APCY5530THYR7_114.8F.pdf"  — built from the model string.
function datasheetFileName(m) {
  const yr = m.series === 'APCY-H' ? 'YR7' : 'YR4';
  return `${m.model}${yr}_114.8F.pdf`;
}

// ---- helpers ----
const byModel = {};
MODELS.forEach(m => { byModel[m.model.toUpperCase()] = m; });

function findByModel(str) {
  if (!str) return null;
  const s = String(str).toUpperCase().replace(/\s+/g, '');
  if (byModel[s]) return byModel[s];
  // tolerate code-only entry like "5530" or "5530TH"
  const codeMatch = s.match(/5(\d{3})(D|T|Q)?(E|H)?/);
  if (codeMatch) {
    const code = '5' + codeMatch[1];
    const hits = MODELS.filter(m => m.code === code &&
      (!codeMatch[3] || m.series.endsWith(codeMatch[3])));
    if (hits.length === 1) return hits[0];
    return hits; // ambiguous (E vs H) -> caller disambiguates
  }
  return null;
}

// Select smallest model in a series whose capacity >= target TR (size-up),
// plus the next size down if it is within tolerance (show-both 5% rule).
function selectByTonnage(targetTR, series) {
  const pool = MODELS.filter(m => m.series === series)
                     .sort((a, b) => a.capacityTR - b.capacityTR);
  const exactOrUp = pool.find(m => m.capacityTR >= targetTR);
  const result = [];
  if (exactOrUp) {
    const idx = pool.indexOf(exactOrUp);
    if (idx > 0) {
      const down = pool[idx - 1];
      if (down.capacityTR >= targetTR * (1 - SIZEUP_TOLERANCE)) result.push(down);
    }
    result.push(exactOrUp);
  } else {
    // target above series max -> return the largest, flagged
    result.push({ ...pool[pool.length - 1], _overRange: true });
  }
  return result;
}

// Compare any two models field-by-field
function compare(modelA, modelB) {
  const a = findByModel(modelA), b = findByModel(modelB);
  if (!a || !b || Array.isArray(a) || Array.isArray(b)) return null;
  return { a, b, deltas: {
    capacityTR: +(b.capacityTR - a.capacityTR).toFixed(1),
    eer:        +(b.eer - a.eer).toFixed(2),
    iplv:       +(b.iplv - a.iplv).toFixed(2),
    totalPowerKW: +(b.totalPowerKW - a.totalPowerKW).toFixed(1),
    opWeightLbs: b.opWeightLbs - a.opWeightLbs
  }};
}

// Series-level rollups (for "compare the two series" style questions)
function seriesStats(series) {
  const p = MODELS.filter(m => m.series === series);
  const f = (arr, fn) => fn(...arr);
  const caps = p.map(m => m.capacityTR), eers = p.map(m => m.eer), iplvs = p.map(m => m.iplv);
  const avg = a => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
  return {
    series, count: p.length,
    capacityMinTR: f(caps, Math.min), capacityMaxTR: f(caps, Math.max),
    eerMin: f(eers, Math.min), eerMax: f(eers, Math.max), eerAvg: avg(eers),
    iplvAvg: avg(iplvs)
  };
}

// kW/TR convenience
const kwPerTR = m => +(m.totalPowerKW / m.capacityTR).toFixed(3);

// ---- formatting for WhatsApp (plain text, no markdown tables) ----
function fmtModel(m) {
  return [
    `*${m.model}*  (${m.series}, ${m.circuits}-circuit)`,
    `Capacity: ${m.capacityTR} TR @ 46°C`,
    `Total power: ${m.totalPowerKW} kW  |  EER ${m.eer}  |  IPLV ${m.iplv}`,
    `kW/TR: ${kwPerTR(m)}`,
    `Compressors: ${m.compConfig} semi-hermetic screw  |  Steps ${m.capacitySteps}`,
    `Refrigerant: R-134a, ${m.refrigChargeLbs} lbs`,
    `Max running current: ${m.maxRunCurrentA} A (size breaker/cable on this)`,
    `Dimensions LxWxH: ${m.lengthIn}" x ${m.widthIn}" x ${m.heightIn}"`,
    `Operating weight: ${m.opWeightLbs.toLocaleString()} lbs`,
    `Sound: ${m.soundDbA} dB(A) @ 1 m`
  ].join('\n');
}

function fmtSelection(list, targetTR, series) {
  if (!list.length) return `No ${series} model found for ${targetTR} TR.`;
  if (list[0]._overRange) {
    return `${targetTR} TR exceeds the ${series} range. Largest is ${list[0].model} ` +
           `at ${list[0].capacityTR} TR. Consider multiple units or APCY-H.`;
  }
  const head = `For ${targetTR} TR (${series}), I'd select:`;
  const lines = list.map(m =>
    `• ${m.model} — ${m.capacityTR} TR, EER ${m.eer}, ${m.totalPowerKW} kW`
    + (list.length > 1 && m === list[0] ? '  (next size down, within 5%)' : ''));
  return [head, ...lines].join('\n');
}

// Plain-text summary for "compare the two series" questions.
function fmtSeriesCompare() {
  const e = seriesStats('APCY-E'), h = seriesStats('APCY-H');
  return [
    `*APCY-E vs APCY-H* (air-cooled screw chillers @ 46°C T3)`,
    ``,
    `APCY-E: ${e.count} models, ${e.capacityMinTR}–${e.capacityMaxTR} TR`,
    `  EER ${e.eerMin}–${e.eerMax} (avg ${e.eerAvg})  |  IPLV avg ${e.iplvAvg}`,
    `APCY-H: ${h.count} models, ${h.capacityMinTR}–${h.capacityMaxTR} TR`,
    `  EER ${h.eerMin}–${h.eerMax} (avg ${h.eerAvg})  |  IPLV avg ${h.iplvAvg}`,
    ``,
    `APCY-H runs higher EER at 46°C; APCY-E is lighter/shorter.`
  ].join('\n');
}

// Plain-text key deltas for a two-model comparison.
function fmtCompare(modelA, modelB) {
  const r = compare(modelA, modelB);
  if (!r) return null;
  const { a, b, deltas } = r;
  const sign = n => (n > 0 ? `+${n}` : `${n}`);
  return [
    `*${a.model}* vs *${b.model}*`,
    ``,
    `Capacity: ${a.capacityTR} → ${b.capacityTR} TR (${sign(deltas.capacityTR)})`,
    `EER: ${a.eer} → ${b.eer} (${sign(deltas.eer)})`,
    `IPLV: ${a.iplv} → ${b.iplv} (${sign(deltas.iplv)})`,
    `Total power: ${a.totalPowerKW} → ${b.totalPowerKW} kW (${sign(deltas.totalPowerKW)})`,
    `Op. weight: ${a.opWeightLbs.toLocaleString()} → ${b.opWeightLbs.toLocaleString()} lbs (${sign(deltas.opWeightLbs)})`
  ].join('\n');
}

// ---- WhatsApp intent routing (mirrors products.js parse/interactive/tap) ----
// Response descriptors handed back to server.js:
//   { type:"text",      text }
//   { type:"buttons",   text, buttons:[{id,title}] }   (server calls sendButtons)
//   { type:"datasheet", series, code }                 (server fetches the PDF)

const COMPARE_RE = /\b(compare|comparison|difference|differ|vs|versus)\b/;
// A model token in free text: optional APCY prefix, 4-digit 5xxx code,
// optional frame letter (D/T/Q) and optional series letter (E/H).
const MODEL_TOKEN_RE = /(?:apcy)?\s*5\d{3}\s*[dtq]?\s*[eh]?/gi;

function mentionsBothSeries(t) {
  const e = /\bapcy-?e\b|\be series\b|\bseries e\b/.test(t);
  const h = /\bapcy-?h\b|\bh series\b|\bseries h\b/.test(t);
  const eh = /\be\s*(?:and|&|vs|versus|\/)\s*h\b/.test(t) && /\bseries\b/.test(t);
  return (e && h) || eh;
}

function seriesFromText(t) {
  if (/\bapcy-?h\b|\bh series\b|\bseries h\b/.test(t)) return 'APCY-H';
  if (/\bapcy-?e\b|\be series\b|\bseries e\b/.test(t)) return 'APCY-E';
  // trailing letter after the tonnage, e.g. "300tr h", "250 ton e"
  if (/\b\d+(?:\.\d+)?\s*(?:tr|ton|tons)\s+h\b/.test(t)) return 'APCY-H';
  if (/\b\d+(?:\.\d+)?\s*(?:tr|ton|tons)\s+e\b/.test(t)) return 'APCY-E';
  return null;
}

// Does this message concern chillers at all? Guard so "chiller"/"ton"/"TR"
// never collide with the APMR/APMR-A/PAC4A package-unit routing: we only fire
// on the word "chiller", an APCY token, a model carrying a series letter, a
// known bare chiller code, or a two-series comparison question.
function isChillerRequest(text) {
  const t = ` ${String(text || '').toLowerCase().trim()} `;
  if (/\bchiller\b/.test(t)) return true;
  if (/\bapcy/.test(t)) return true;
  if (/\b5\d{3}\s*[dtq]?\s*[eh]\b/.test(t)) return true; // model with series letter
  if (COMPARE_RE.test(t) && mentionsBothSeries(t)) return true;
  // bare 4-digit code that is a real chiller code (e.g. "5285", "5530")
  const bare = t.match(/\b5\d{3}\b/g) || [];
  if (bare.some(c => MODELS.some(m => m.code === c))) return true;
  return false;
}

// Build the descriptor for a resolved single model (spec card + datasheet btn).
function modelDescriptor(m) {
  return {
    type: 'buttons',
    text: fmtModel(m),
    buttons: [{ id: `chds|${m.code}|${m.series}`, title: `📄 ${m.code} sheet` }],
  };
}

// Build the descriptor for a tonnage selection in a known series.
function selectionDescriptor(tr, series) {
  const list = selectByTonnage(tr, series);
  const text = fmtSelection(list, tr, series);
  const top = list[list.length - 1]; // meets-load model (or largest if over-range)
  const buttons = [];
  if (top && top.code) buttons.push({ id: `chds|${top.code}|${series}`, title: `📄 ${top.code} sheet` });
  return buttons.length ? { type: 'buttons', text, buttons } : { type: 'text', text };
}

function seriesPickButtons(prefix, codeOrTr, label) {
  return [
    { id: `${prefix}|${codeOrTr}|APCY-E`, title: label('APCY-E') },
    { id: `${prefix}|${codeOrTr}|APCY-H`, title: label('APCY-H') },
  ];
}

// Main text router. Returns a response descriptor, or null to let the existing
// (catalogue/IOM, sheet-rule, AI) flow handle it — e.g. bare "APCY-H".
function routeChillerText(text) {
  if (!isChillerRequest(text)) return null;
  const t = ` ${String(text).toLowerCase().trim()} `;
  const wantsDatasheet = /\bdata\s*sheet\b|\bdatasheet\b|\bspec\s*sheet\b|\bspecs?\b/.test(t);

  // Model tokens that carry a series letter (unambiguous), for two-model compare.
  const titledTokens = (t.match(/(?:apcy)?\s*5\d{3}\s*[dtq]?\s*[eh]/gi) || [])
    .map(s => s.replace(/\s+/g, ''));

  // (e) Two-model compare: "compare 5285DE and 5285DH"
  if (COMPARE_RE.test(t) && titledTokens.length >= 2) {
    const out = fmtCompare(titledTokens[0], titledTokens[1]);
    if (out) return { type: 'text', text: out };
  }

  // (d) Series compare: "compare APCY-E and APCY-H" / "difference between E and H series"
  if (COMPARE_RE.test(t) && mentionsBothSeries(t)) {
    return { type: 'text', text: fmtSeriesCompare() };
  }

  // (a/c) Model lookup or datasheet for a specific model.
  const firstToken = (text.match(MODEL_TOKEN_RE) || [])[0];
  if (firstToken) {
    const resolved = findByModel(firstToken.replace(/\s+/g, ''));
    if (Array.isArray(resolved) && resolved.length > 1) {
      // Ambiguous (exists in both series) -> disambiguate.
      const code = resolved[0].code;
      if (wantsDatasheet) {
        return {
          type: 'buttons',
          text: `Which series datasheet for ${code}?`,
          buttons: seriesPickButtons('chds', code, s => `${s.slice(-1)} ${code} sheet`),
        };
      }
      return {
        type: 'buttons',
        text: `${code} exists in both series — which one?`,
        buttons: seriesPickButtons('chmodel', code, s => `${s} ${code}`),
      };
    }
    const m = Array.isArray(resolved) ? resolved[0] : resolved;
    if (m) {
      if (wantsDatasheet) return { type: 'datasheet', series: m.series, code: m.code };
      return modelDescriptor(m);
    }
    // token looked like a code but matched nothing -> fall through to tonnage
  }

  // (b) Tonnage selection: "400 TR chiller", "chiller 300TR H"
  const trMatch = t.match(/(\d+(?:\.\d+)?)\s*(?:tr|ton|tons)\b/);
  if (trMatch) {
    const tr = parseFloat(trMatch[1]);
    const series = seriesFromText(t);
    if (series) return selectionDescriptor(tr, series);
    return {
      type: 'buttons',
      text: `${tr} TR chiller — which series?`,
      buttons: seriesPickButtons('chsel', tr, s => s),
    };
  }

  return null; // chiller-ish but no concrete intent -> let catalogue/AI handle it
}

// Handle a chiller button tap. Returns a response descriptor or null.
function handleChillerButton(btnId) {
  if (!btnId) return null;
  const parts = btnId.split('|');
  if (parts[0] === 'chmodel') {
    const [, code, series] = parts;
    const m = MODELS.find(x => x.code === code && x.series === series);
    return m ? modelDescriptor(m) : null;
  }
  if (parts[0] === 'chsel') {
    const [, trStr, series] = parts;
    const tr = parseFloat(trStr);
    if (!isFinite(tr) || !SERIES.includes(series)) return null;
    return selectionDescriptor(tr, series);
  }
  if (parts[0] === 'chds') {
    const [, code, series] = parts;
    if (!SERIES.includes(series)) return null;
    return { type: 'datasheet', series, code };
  }
  return null;
}

module.exports = {
  DB, MODELS, SERIES, DATASHEET_FOLDERS,
  findByModel, selectByTonnage, compare, seriesStats, kwPerTR,
  datasheetFileName, fmtModel, fmtSelection, fmtSeriesCompare, fmtCompare,
  isChillerRequest, routeChillerText, handleChillerButton,
};
