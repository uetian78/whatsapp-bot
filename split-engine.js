// ============================================================
//  split-engine.js — Toshiba/TCL/SKM split unit selection engine
//  Ported from Split Selection.html embedded JS
// ============================================================
const DATA = require("./split-data.json");
const { FAMILIES, INDOOR, OUTDOOR, SH_INDOOR, SH_OUTDOOR } = DATA;

// Exported family menu for the bot
const FAMILY_MENU = [
  { key: "PKV",    label: "Toshiba Hi-Wall (RAS-18/24/30PKV)",         kind: "grid" },
  { key: "BSP",    label: "Toshiba Ducted Non-Inverter (RAV BSP/ASP)", kind: "grid" },
  { key: "SH",     label: "Toshiba Ducted Inverter (RAV SH)",          kind: "grid" },
  { key: "TCL-HW", label: "TCL Hi-Wall (SaveIN AI)",                   kind: "t1t3" },
  { key: "SKM-HW", label: "SKM Hi-Wall (MSKMP-CVK1C60)",               kind: "t1t3" },
  { key: "SKM-DCT",label: "SKM Ducted (Sierra DDP+RX)",                kind: "t1t3" },
];

function round(x, d = 2) {
  const k = 10 ** d;
  return Math.round(x * k) / k;
}

function locAxis(a, v) {
  const n = a.length;
  if (v <= a[0]) return { i0: 0, i1: 0, f: 0, c: v < a[0] ? "low" : null };
  if (v >= a[n - 1]) return { i0: n - 1, i1: n - 1, f: 0, c: v > a[n - 1] ? "high" : null };
  for (let i = 0; i < n - 1; i++)
    if (v >= a[i] && v <= a[i + 1])
      return { i0: i, i1: i + 1, f: (v - a[i]) / (a[i + 1] - a[i]), c: null };
  return { i0: n - 1, i1: n - 1, f: 0, c: "high" };
}

function famAxes(famKey) {
  const f = FAMILIES[famKey] || {};
  return { ind: f.indoor || INDOOR, out: f.outdoor || OUTDOOR };
}

// Rate one model. For grid families: bilinear interpolation on DB (indoor) × outdoor.
// For t1t3 families: return rated value at T1 or T3.
function rate(famKey, modelKey, idb, iwb, odb, condition = "T3") {
  const fam = FAMILIES[famKey];
  const m = fam && fam.models[modelKey];
  if (!m) return null;

  if (fam.kind === "t1t3") {
    const pt = condition === "T1" ? m.t1 : m.t3;
    if (!pt) return null;
    return {
      tc: round(pt.tc), shc: null, p: round(pt.p),
      shr: null, eer: round(pt.p > 0 ? pt.tc / pt.p : 0),
      inGrid: true, t1t3: true,
      note: `Rated at ${condition} (${condition === "T1" ? "27/19°C @ 35°C" : "29/19°C @ 46°C"})`,
    };
  }

  // Grid interpolation
  if (!m.grid || !m.grid.length) return null;
  const { ind, out } = famAxes(famKey);
  const dbAxis = ind.map(c => c.db);
  const indL = locAxis(dbAxis, idb);
  const outL = locAxis(out, odb);
  const warnings = [];
  if (outL.c) warnings.push(`Ambient ${odb}°C ${outL.c === "low" ? "below" : "above"} table (${out[0]}–${out[out.length-1]}°C); clamped.`);
  if (indL.c) warnings.push(`On-coil DB ${idb}°C ${indL.c === "low" ? "below" : "above"} table (${dbAxis[0]}–${dbAxis[dbAxis.length-1]}°C); clamped.`);

  const cell = (r, c) => m.grid[r][c];
  const bl = mi => {
    const c00 = cell(outL.i0, indL.i0)[mi], c01 = cell(outL.i0, indL.i1)[mi];
    const c10 = cell(outL.i1, indL.i0)[mi], c11 = cell(outL.i1, indL.i1)[mi];
    const top = c00 + (c01 - c00) * indL.f;
    const bot = c10 + (c11 - c10) * indL.f;
    return top + (bot - top) * outL.f;
  };

  const tc = bl(0), shc = bl(1), p = bl(2);
  return {
    tc: round(tc), shc: round(shc), p: round(p),
    shr: round(tc > 0 ? Math.min(shc, tc) / tc : 0, 3),
    eer: round(p > 0 ? tc / p : 0),
    inGrid: !outL.c && !indL.c,
    t1t3: false,
    warnings,
  };
}

// Auto-select: rank all models in a family for a given load and conditions.
function rankSplit(famKey, loadKw, idb, iwb, odb, condition = "T3", tol = 0) {
  const fam = FAMILIES[famKey];
  if (!fam) return [];
  return Object.keys(fam.models)
    .map(key => {
      const r = rate(famKey, key, idb, iwb, odb, condition);
      if (!r) return null;
      const margin = round((r.tc - loadKw) / loadKw, 3);
      return { key, label: fam.models[key].label, ...r, margin, adequate: r.tc >= loadKw * (1 - tol) };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.adequate !== b.adequate) return a.adequate ? -1 : 1;
      return a.adequate ? a.tc - b.tc : b.tc - a.tc;
    });
}

module.exports = { FAMILIES, FAMILY_MENU, rate, rankSplit };
