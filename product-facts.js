// ============================================================
//  PRODUCT LISTS: "give me list of APMR units" and the like, built from the
//  structured spec data the selection code uses (products.js + chillers.js).
// ============================================================

const { PRODUCTS } = require("./products.js");
const chillers = require("./chillers.js");
const { detectSeriesEntry } = require("./catalogue-map.js");

// ============================================================
//  "LIST UNITS" — e.g. "give me list of APMR units"
//  Returns a formatted list of every model in a series with its
//  capacity and airflow, built from the same structured data.
// ============================================================

// Shared "does this text ask for a list/lineup?" check, used both by the
// structured list below and by the unsupported-series fallback.
function wantsListIntent(t) {
  return (
    /\b(list|all|every|complete|entire|whole|models?|range|line\s?-?up|lineup)\b/.test(t) ||
    /\bwhat\b.*\b(do you have|are there|available|offer)\b/.test(t)
  );
}

// Detect a list-style request and which family/families it names.
// Returns an array of keys (e.g. ["apmr"], ["fcu-dmp","fcu-dcmp"],
// ["chiller:APCY-E"]) or null if it isn't a list request.
function parseListRequest(text) {
  const t = (text || "").toLowerCase();

  // A document request, a specific model code, or a sized selection is NOT a list.
  if (/\b(catalog(?:ue)?|iom|datasheet|data ?sheet|manual|brochure)\b/.test(t)) return null;
  if (/\b\d{5}\b/.test(t)) return null;
  if (/\d+(?:\.\d+)?\s*(?:tr|ton|tons|cfm)\b/.test(t)) return null;

  // A bare "APMRG1" / "APMR G1" (optionally + units/models/series) also means
  // the list: the series has no catalogue/IOM entry in the map, so without
  // this it would fall to the old APMR catalogue menu.
  if (/^\s*apmr[\s-]?g1(\s+(units?|models?|series))?\s*$/.test(t)) return ["apmr-g1"];

  if (!wantsListIntent(t)) return null;

  if (/\bapmr-?a\b/.test(t)) return ["apmr-a"];
  // APMRG1 before bare "apmr" — "apmr g1" would otherwise match "apmr".
  if (/\bapmr[\s-]?g1\b/.test(t)) return ["apmr-g1"];
  // APMR-V is a distinct series with no spec table of its own — don't let the
  // bare "apmr" check below swallow it (word-boundary regex treats the
  // hyphen as a boundary, so "apmr-v" would otherwise match "apmr").
  if (/\bapmr-?v\b/.test(t)) return null;
  if (/\bapmr\b/.test(t)) return ["apmr"];
  if (/\bpac4a\b|\bfresh air\b|\bdoas\b/.test(t)) return ["pac4a"];
  if (/\bdcmp\b/.test(t)) return ["fcu-dcmp"];
  if (/\bdmp\b/.test(t)) return ["fcu-dmp"];
  if (/\bfcu\b|\bfan[\s-]?coil\b/.test(t)) return ["fcu-dmp", "fcu-dcmp"];
  if (/\bapcy-?e\b/.test(t)) return ["chiller:APCY-E"];
  if (/\bapcy-?h\b/.test(t)) return ["chiller:APCY-H"];
  if (/\bapcy\b|\bchiller(s)?\b/.test(t)) return ["chiller:APCY-E", "chiller:APCY-H"];
  return null;
}

// Canonical catalogue-map series names already covered by parseListRequest
// above — skip them here so this fallback never fights the real list.
const SUPPORTED_LIST_SERIES = new Set(["APMR-A", "APMR", "PAC4A", "FCU", "APCY-E", "APCY-H"]);

// A list-style request ("ACMR models", "list of CRAC", "MAH model") for a
// series that IS in the catalogue map but has no structured spec table to
// build a list from. Returns { name, catalogue } so the caller can say a
// list isn't available and offer the catalogue (which lists every model)
// as a download instead, or null if this isn't that case.
function parseUnsupportedSeriesListRequest(text) {
  const t = (text || "").toLowerCase();
  if (/\b(catalog(?:ue)?|iom|datasheet|data ?sheet|manual|brochure)\b/.test(t)) return null;
  if (!wantsListIntent(t)) return null;
  if (parseListRequest(text)) return null; // already has a real structured list

  const entry = detectSeriesEntry(text);
  if (!entry || SUPPORTED_LIST_SERIES.has(entry.name)) return null;
  return { name: entry.name, catalogue: !!entry.catalogue };
}

const tr1 = (v) => Number(v).toFixed(1); // one-decimal TR for tidy columns

// Unit conversions for the Imperial <-> International (SI) list toggle.
const KW_PER_TR = 3.51685;       // 1 ton refrigeration = 3.51685 kW
const LPS_PER_CFM = 0.471947;    // 1 CFM = 0.471947 L/s
const trToKw = (tr) => Math.round(tr * KW_PER_TR * 10) / 10;
const cfmToLps = (cfm) => Math.round(cfm * LPS_PER_CFM);
const kw1 = (v) => Number(v).toFixed(1);

// system: "imp" (TR + CFM) | "si" (kW + L/s). Default "imp" = legacy output.
function packagedSection(key, system = "imp") {
  const p = PRODUCTS[key];
  const head =
    `*${p.label}*${p.refrigerant ? ` (${p.refrigerant})` : ""}\n` +
    `${p.models.length} models — cooling T1(35°C) / T3(46°C), supply airflow:\n`;
  const lines = p.models.map((m) =>
    system === "si"
      ? `• ${m.fullModel} — ${kw1(m.t1_kw)} / ${kw1(m.t3_kw)} kW — ${cfmToLps(m.cfm)} L/s`
      : `• ${m.fullModel} — ${tr1(m.t1_tr)} / ${tr1(m.t3_tr)} TR — ${m.cfm} CFM`);
  return head + lines.join("\n");
}

// APMRG1: one capacity column — T3 net (46°C), the only rating in the catalogue.
function g1Section(key, system = "imp") {
  const p = PRODUCTS[key];
  const head =
    `*${p.label}*${p.refrigerant ? ` (${p.refrigerant})` : ""}\n` +
    `${p.models.length} models — net cooling at T3 (46°C), supply airflow, EER:\n`;
  const lines = p.models.map((m) =>
    system === "si"
      ? `• ${m.fullModel} — ${kw1(m.cap_kw)} kW — ${cfmToLps(m.cfm)} L/s — EER ${m.eer.toFixed(2)}`
      : `• ${m.fullModel} — ${tr1(m.cap_tr)} TR — ${m.cfm} CFM — EER ${m.eer.toFixed(2)}`);
  const foot = "\n_Catalogue rates T3 only (29°C DB / 19°C WB entering air)._";
  return head + lines.join("\n") + foot;
}

function freshSection(key, system = "imp") {
  const p = PRODUCTS[key];
  const head =
    `*${p.label}*${p.refrigerant ? ` (${p.refrigerant})` : ""}\n` +
    `${p.models.length} models — cooling @46.1°C, fresh airflow:\n`;
  const lines = p.models.map((m) =>
    system === "si"
      ? `• ${m.fullModel} — ${kw1(m.cap_kw)} kW — ${cfmToLps(m.cfm)} L/s`
      : `• ${m.fullModel} — ${tr1(m.cap_tr)} TR — ${m.cfm} CFM`);
  return head + lines.join("\n");
}

function fcuSection(key, system = "imp") {
  const p = PRODUCTS[key];
  const codes = [];
  for (const m of p.models) if (!codes.includes(m.code)) codes.push(m.code);
  const lines = codes.map((code) => {
    const r3 = p.models.find((m) => m.code === code && m.rows === 3);
    const r4 = p.models.find((m) => m.code === code && m.rows === 4);
    const cap =
      system === "si"
        ? [r3 && `3-row ${kw1(r3.cap_kw)}`, r4 && `4-row ${kw1(r4.cap_kw)}`].filter(Boolean).join(" / ")
        : [r3 && `3-row ${tr1(r3.cap_tr)}`, r4 && `4-row ${tr1(r4.cap_tr)}`].filter(Boolean).join(" / ");
    const nom = (r3 || r4).nomCfm;
    const capUnit = system === "si" ? "kW" : "TR";
    const air = system === "si" ? `${cfmToLps(nom)} L/s nom` : `${nom} CFM nom`;
    return `• ${p.namePrefix}${code} — ${cap} ${capUnit} — ${air}`;
  });
  const head = `*${p.label}*\n${codes.length} models — cooling (3-row / 4-row), nominal airflow:\n`;
  return head + lines.join("\n");
}

function chillerSection(series, system = "imp") {
  const models = (chillers.MODELS || []).filter((m) => m.series === series);
  const head = `*${series} Air-Cooled Screw Chillers* (R-134a)\n${models.length} models — cooling capacity, EER:\n`;
  const lines = models.map((m) => {
    const cap = system === "si" ? `${kw1(trToKw(m.capacityTR))} kW` : `${m.capacityTR} TR`;
    return `• ${m.model} — ${cap}${m.eer != null ? ` — EER ${m.eer}` : ""}`;
  });
  return head + lines.join("\n");
}

// Build the full list text for the matched keys, or null.
// system: "imp" (default, Imperial: TR + CFM) or "si" (International: kW + L/s).
function buildUnitList(keys, system = "imp") {
  const sections = (keys || [])
    .map((k) => {
      if (k === "apmr" || k === "apmr-a") return packagedSection(k, system);
      if (k === "apmr-g1") return g1Section(k, system);
      if (k === "pac4a") return freshSection(k, system);
      if (k === "fcu-dmp" || k === "fcu-dcmp") return fcuSection(k, system);
      if (k.startsWith("chiller:")) return chillerSection(k.split(":")[1], system);
      return null;
    })
    .filter(Boolean);
  if (!sections.length) return null;
  return sections.join("\n\n");
}

module.exports = {
  parseListRequest,
  parseUnsupportedSeriesListRequest,
  buildUnitList,
};
