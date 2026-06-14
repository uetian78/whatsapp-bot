// ============================================================
//  PRODUCT KNOWLEDGE BASE (for "Quick Questions about products")
//  Serializes the SAME structured spec data the selection engines use
//  (products.js + chillers.js) into a compact factual text. This is fed
//  to Claude so product questions are answered from REAL catalogue/
//  datasheet numbers — the AI is never asked to invent a spec.
// ============================================================

const { PRODUCTS } = require("./products.js");
const chillers = require("./chillers.js");

// Packaged units (APMR / APMR-A): T1 + T3 capacities.
function packagedLines(key) {
  return PRODUCTS[key].models.map(
    (m) =>
      `${m.fullModel}: cooling T1(35°C)=${m.t1_tr} TR (${m.t1_kw} kW), ` +
      `T3(46°C)=${m.t3_tr} TR (${m.t3_kw} kW); supply air ${m.cfm} CFM`
  );
}

// PAC4A fresh-air / DOAS: single condition at 46.1°C.
function freshLines(key) {
  return PRODUCTS[key].models.map(
    (m) => `${m.fullModel}: cooling ${m.cap_tr} TR (${m.cap_kw} kW) at 46.1°C; fresh air ${m.cfm} CFM`
  );
}

// FCU DMP / DCMP chilled-water fan coils: 3-row and 4-row coil variants.
function fcuLines(key) {
  return PRODUCTS[key].models.map(
    (m) =>
      `${m.fullModel}: ${m.rows}-row coil, ${m.cap_tr} TR (${m.cap_kw} kW), ` +
      `${m.cfm} CFM actual (nominal size ${m.nomCfm})`
  );
}

// APCY-E / APCY-H air-cooled screw chillers: full performance + physical data.
function chillerLine(m) {
  const parts = [`${m.model} (${m.series}): ${m.capacityTR} TR cooling`];
  if (m.eer != null) parts.push(`EER ${m.eer}`);
  if (m.iplv != null) parts.push(`IPLV ${m.iplv}`);
  if (m.totalPowerKW != null) parts.push(`total power ${m.totalPowerKW} kW`);
  if (m.circuits != null) parts.push(`${m.circuits} circuits`);
  if (m.lengthIn && m.widthIn && m.heightIn)
    parts.push(`dims ${m.lengthIn}×${m.widthIn}×${m.heightIn} in`);
  if (m.opWeightLbs != null) parts.push(`operating weight ${m.opWeightLbs} lbs`);
  if (m.soundDbA != null) parts.push(`sound ${m.soundDbA} dBA`);
  return parts.join(", ");
}

function buildProductKnowledge() {
  const out = [];
  out.push("=== MANNAI / SKM HVAC PRODUCT SPECIFICATIONS (from catalogues & datasheets) ===");
  out.push("Notation: T1 = 35°C ambient, T3 = 46°C ambient. 1 TR (ton) = 3.51685 kW. CFM = airflow.");
  out.push("Use these exact figures; if a value is not listed, say it isn't available.");
  out.push("");

  out.push("## APMR Packaged Air Conditioners (R-410A, 5–28 TR):");
  out.push(...packagedLines("apmr"));
  out.push("");

  out.push("## APMR-A Packaged Air Conditioners (R-410A):");
  out.push(...packagedLines("apmr-a"));
  out.push("");

  out.push("## PAC4A 100% Fresh Air / DOAS Units (R-410A, capacity at 46.1°C):");
  out.push(...freshLines("pac4a"));
  out.push("");

  out.push("## FCU DMP Standard Chilled-Water Fan Coils (45°F EWT, medium speed, 50 Pa ESP):");
  out.push(...fcuLines("fcu-dmp"));
  out.push("");

  out.push("## FCU DCMP District-Cooling Fan Coils (43°F EWT, medium speed, 50 Pa ESP):");
  out.push(...fcuLines("fcu-dcmp"));
  out.push("");

  out.push("## APCY-E / APCY-H Air-Cooled Screw Chillers (R-134a, capacity at 45°F LCWT):");
  out.push(...(chillers.MODELS || []).map(chillerLine));

  return out.join("\n");
}

// Built once at module load (the data is static).
const PRODUCT_KB = buildProductKnowledge();

// ============================================================
//  "LIST UNITS" — e.g. "give me list of APMR units"
//  Returns a formatted list of every model in a series with its
//  capacity and airflow, built from the same structured data.
// ============================================================

// Detect a list-style request and which family/families it names.
// Returns an array of keys (e.g. ["apmr"], ["fcu-dmp","fcu-dcmp"],
// ["chiller:APCY-E"]) or null if it isn't a list request.
function parseListRequest(text) {
  const t = (text || "").toLowerCase();

  // A document request, a specific model code, or a sized selection is NOT a list.
  if (/\b(catalog(?:ue)?|iom|datasheet|data ?sheet|manual|brochure)\b/.test(t)) return null;
  if (/\b\d{5}\b/.test(t)) return null;
  if (/\d+(?:\.\d+)?\s*(?:tr|ton|tons|cfm)\b/.test(t)) return null;

  const wantsList =
    /\b(list|all|every|complete|entire|whole|models?|range|line\s?-?up|lineup)\b/.test(t) ||
    /\bwhat\b.*\b(do you have|are there|available|offer)\b/.test(t);
  if (!wantsList) return null;

  if (/\bapmr-?a\b/.test(t)) return ["apmr-a"];
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

const tr1 = (v) => Number(v).toFixed(1); // one-decimal TR for tidy columns

// Unit conversions for the Imperial <-> International (SI) list toggle.
const KW_PER_TR = 3.51685;       // 1 ton refrigeration = 3.51685 kW
const M3H_PER_CFM = 1.69901;     // 1 CFM = 1.69901 m³/h
const trToKw = (tr) => Math.round(tr * KW_PER_TR * 10) / 10;
const cfmToM3h = (cfm) => Math.round(cfm * M3H_PER_CFM);
const kw1 = (v) => Number(v).toFixed(1);

// system: "imp" (TR + CFM) | "si" (kW + m³/h). Default "imp" = legacy output.
function packagedSection(key, system = "imp") {
  const p = PRODUCTS[key];
  const head =
    `*${p.label}*${p.refrigerant ? ` (${p.refrigerant})` : ""}\n` +
    `${p.models.length} models — cooling T1(35°C) / T3(46°C), supply airflow:\n`;
  const lines = p.models.map((m) =>
    system === "si"
      ? `• ${m.fullModel} — ${kw1(m.t1_kw)} / ${kw1(m.t3_kw)} kW — ${cfmToM3h(m.cfm)} m³/h`
      : `• ${m.fullModel} — ${tr1(m.t1_tr)} / ${tr1(m.t3_tr)} TR — ${m.cfm} CFM`);
  return head + lines.join("\n");
}

function freshSection(key, system = "imp") {
  const p = PRODUCTS[key];
  const head =
    `*${p.label}*${p.refrigerant ? ` (${p.refrigerant})` : ""}\n` +
    `${p.models.length} models — cooling @46.1°C, fresh airflow:\n`;
  const lines = p.models.map((m) =>
    system === "si"
      ? `• ${m.fullModel} — ${kw1(m.cap_kw)} kW — ${cfmToM3h(m.cfm)} m³/h`
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
    const air = system === "si" ? `${cfmToM3h(nom)} m³/h nom` : `${nom} CFM nom`;
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
// system: "imp" (default, Imperial: TR + CFM) or "si" (International: kW + m³/h).
function buildUnitList(keys, system = "imp") {
  const sections = (keys || [])
    .map((k) => {
      if (k === "apmr" || k === "apmr-a") return packagedSection(k, system);
      if (k === "pac4a") return freshSection(k, system);
      if (k === "fcu-dmp" || k === "fcu-dcmp") return fcuSection(k, system);
      if (k.startsWith("chiller:")) return chillerSection(k.split(":")[1], system);
      return null;
    })
    .filter(Boolean);
  if (!sections.length) return null;
  return sections.join("\n\n");
}

module.exports = { PRODUCT_KB, buildProductKnowledge, parseListRequest, buildUnitList };
