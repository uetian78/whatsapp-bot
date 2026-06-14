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

// ============================================================
//  "LIST SPLITS" — e.g. "list of split units", "show toshiba splits"
//  Returns every model in the matched families with its TOTAL cooling
//  capacity at T1 (35°C) and T3 (46°C), plus power and EER. Capacities
//  for grid families are interpolated at the standard indoor rating
//  point (27°C DB T1 / 29°C DB T3, 19°C WB); t1t3 families read their
//  rated T1/T3 directly. NOTE: airflow/CFM is not in this dataset.
// ============================================================

// Standard rating conditions (mirror parseSplitLine presets in server.js).
const T1_COND = { idb: 27, iwb: 19, odb: 35 };
const T3_COND = { idb: 29, iwb: 19, odb: 46 };

// Brand each family belongs to (from its data.brand field).
function famBrand(famKey) {
  return (FAMILIES[famKey] && FAMILIES[famKey].brand) || "";
}

// Decide which families a list request targets. Returns an array of family
// keys (in FAMILY_MENU order) or null if it isn't a split-list request.
function parseSplitListRequest(text) {
  const t = (text || "").toLowerCase();

  // Must mention splits/split unit AND a list intent — keeps it clear of the
  // interactive "Split Selection" trigger and of sized selection lines.
  const mentionsSplit = /\bsplits?\b|\bsplit\s*units?\b/.test(t);
  if (!mentionsSplit) return null;
  // A document or a sized selection is not a list request.
  if (/\b(catalog(?:ue)?|iom|datasheet|data ?sheet|manual|brochure)\b/.test(t)) return null;
  if (/\bselection\b/.test(t)) return null;             // "Split Selection" = interactive
  if (/\d+(?:\.\d+)?\s*(?:kw|tr|ton|tons)\b/.test(t)) return null; // a load line

  const wantsList =
    /\b(list|all|every|complete|entire|whole|models?|range|line\s?-?up|lineup|show|available|options?|what)\b/.test(t);
  if (!wantsList) return null;

  // Optional brand / type filters.
  const wantToshiba = /\btoshiba\b/.test(t);
  const wantTcl     = /\btcl\b/.test(t);
  const wantSkm     = /\bskm\b/.test(t);
  const anyBrand    = wantToshiba || wantTcl || wantSkm;

  const wantHiWall  = /\bhi[\s-]?wall\b|\bhigh[\s-]?wall\b|\bwall\b/.test(t);
  const wantDucted  = /\bducted\b|\bduct\b|\bconcealed\b/.test(t);
  const anyType     = wantHiWall || wantDucted;

  const keys = FAMILY_MENU.map((f) => f.key).filter((key) => {
    const fam = FAMILIES[key];
    if (!fam) return false;
    if (anyBrand) {
      const b = (fam.brand || "").toLowerCase();
      if (wantToshiba && b === "toshiba") { /* keep */ }
      else if (wantTcl && b === "tcl") { /* keep */ }
      else if (wantSkm && b === "skm") { /* keep */ }
      else return false;
    }
    if (anyType) {
      const isHiWall = /hi-?wall|wall/i.test(fam.short + " " + fam.name);
      const isDucted = /duct/i.test(fam.short + " " + fam.name);
      if (wantHiWall && isHiWall) { /* keep */ }
      else if (wantDucted && isDucted) { /* keep */ }
      else return false;
    }
    return true;
  });

  return keys.length ? keys : FAMILY_MENU.map((f) => f.key);
}

// One model line: "• RAS-18PKV — 5.3 / 4.55 kW — EER 3.63 / 2.45".
function splitModelLine(famKey, modelKey) {
  const t1 = rate(famKey, modelKey, T1_COND.idb, T1_COND.iwb, T1_COND.odb, "T1");
  const t3 = rate(famKey, modelKey, T3_COND.idb, T3_COND.iwb, T3_COND.odb, "T3");
  const f2 = (v) => (v != null ? Number(v).toFixed(2) : "—");
  const label = (FAMILIES[famKey].models[modelKey].label || modelKey).split("/")[0].trim();
  const tcStr = `${f2(t1 && t1.tc)} / ${f2(t3 && t3.tc)} kW`;
  const eerStr = `EER ${f2(t1 && t1.eer)} / ${f2(t3 && t3.eer)}`;
  return `• ${label} — ${tcStr} — ${eerStr}`;
}

// Build one family's section.
function splitFamilySection(famKey) {
  const fam = FAMILIES[famKey];
  if (!fam) return null;
  const menu = FAMILY_MENU.find((f) => f.key === famKey);
  const title = menu ? menu.label : `${fam.brand} ${fam.name}`;
  const modelKeys = Object.keys(fam.models);
  const head =
    `*${title}*\n` +
    `${modelKeys.length} model${modelKeys.length !== 1 ? "s" : ""} — total cooling T1(35°C) / T3(46°C), EER:`;
  const lines = modelKeys.map((mk) => splitModelLine(famKey, mk));
  return head + "\n" + lines.join("\n");
}

// Build the full list text for the matched family keys, or null.
function listSplits(keys) {
  const sections = (keys || []).map(splitFamilySection).filter(Boolean);
  if (!sections.length) return null;
  return (
    "🧊 *Split Units*\n" +
    sections.join("\n\n") +
    "\n\n_Capacities are total cooling (kW); airflow/CFM is not in this dataset._\n" +
    "Type *Split Selection* to size a unit for a specific load."
  );
}

module.exports = {
  FAMILIES, FAMILY_MENU, rate, rankSplit,
  parseSplitListRequest, listSplits,
};
