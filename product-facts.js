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

module.exports = { PRODUCT_KB, buildProductKnowledge };
