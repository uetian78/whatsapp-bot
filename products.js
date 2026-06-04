// ============================================================
//  PRODUCT SELECTION DATA + LOGIC
//  Capacities verified from SKM catalogues.
//  T1 = 35C condenser entering air; T3 = 46C condenser entering air.
//  TR = kW / 3.51685
//
//  To add a product line: add an entry to PRODUCTS with its models.
//  Each model: { code, model, cfm, t1_tr, t1_kw, t3_tr, t3_kw }
// ============================================================

const TR_KW = 3.51685;

const PRODUCTS = {
  // APMR-A Packaged Air Conditioners (R-410A)
  "apmr-a": {
    label: "APMR-A Packaged Air Conditioner",
    fileKeyword: "apmr-a", // how the catalogue/data sheet is requested
    selectBy: "tr",         // selection is by tonnage with T1/T3
    models: [
      { code: "51004", cfm: 1670, t1_kw: 15.2, t3_kw: 13.6 },
      { code: "51005", cfm: 2000, t1_kw: 17.1, t3_kw: 15.1 },
      { code: "51007", cfm: 2400, t1_kw: 22.0, t3_kw: 19.7 },
      { code: "51008", cfm: 2880, t1_kw: 24.2, t3_kw: 21.6 },
      { code: "52010", cfm: 4000, t1_kw: 35.0, t3_kw: 31.1 },
      { code: "52012", cfm: 5000, t1_kw: 44.0, t3_kw: 39.4 },
      { code: "52013", cfm: 6000, t1_kw: 46.2, t3_kw: 40.7 },
      { code: "52015", cfm: 6000, t1_kw: 50.9, t3_kw: 44.3 },
      { code: "52017", cfm: 7000, t1_kw: 59.3, t3_kw: 51.9 },
      { code: "52020", cfm: 8000, t1_kw: 71.1, t3_kw: 61.8 },
      { code: "52024", cfm: 8000, t1_kw: 77.1, t3_kw: 66.7 },
      { code: "52025", cfm: 9100, t1_kw: 87.3, t3_kw: 75.4 },
      { code: "52028", cfm: 9800, t1_kw: 98.1, t3_kw: 87.5 },
      { code: "52034", cfm: 10400, t1_kw: 108.2, t3_kw: 96.3 },
      { code: "52039", cfm: 11700, t1_kw: 123.5, t3_kw: 109.9 },
      { code: "52045", cfm: 14600, t1_kw: 143.6, t3_kw: 128.1 },
      { code: "52049", cfm: 15500, t1_kw: 157.8, t3_kw: 141.0 },
      { code: "52052", cfm: 17200, t1_kw: 171.9, t3_kw: 152.7 },
      { code: "52060", cfm: 18500, t1_kw: 183.3, t3_kw: 163.7 },
      { code: "52065", cfm: 23000, t1_kw: 222.5, t3_kw: 198.2 },
      { code: "52070", cfm: 23000, t1_kw: 249.6, t3_kw: 221.8 },
      { code: "52080", cfm: 25600, t1_kw: 256.1, t3_kw: 227.9 },
      { code: "52085", cfm: 30000, t1_kw: 289.0, t3_kw: 258.4 },
      { code: "52090", cfm: 31500, t1_kw: 301.9, t3_kw: 269.9 },
      { code: "52095", cfm: 33500, t1_kw: 315.7, t3_kw: 282.2 },
    ],
  },
};

// compute TR for each model once
for (const key of Object.keys(PRODUCTS)) {
  for (const m of PRODUCTS[key].models) {
    m.t1_tr = Math.round((m.t1_kw / TR_KW) * 10) / 10;
    m.t3_tr = Math.round((m.t3_kw / TR_KW) * 10) / 10;
    m.fullModel = `APMR ${m.code}A`;
  }
}

// Parse a free-text request like:
//   "package unit 20 tr t3", "apmr-a 20 ton", "20 tr at t3 packaged"
// Returns { product, tr, condition } or null.
function parseSelectionRequest(text) {
  const t = text.toLowerCase();

  // Fresh-air / DOAS requests belong to PAC4A, not APMR-A.
  // (PAC4A selection-by-tonnage will be added when its data PDF is in Drive.)
  const isFreshAir = /\bfresh air\b|\bdoas\b|\bpac4a\b|outside air|100% fresh/.test(t);
  if (isFreshAir) return null; // let folder/AI handle PAC4A for now

  // must look like a standard packaged-unit / APMR request
  const isPackaged =
    /\bapmr\b|\bapmr-?a\b|packaged|package unit|package ac/.test(t);
  if (!isPackaged) return null;

  // tonnage: "20 tr", "20 ton", "20 tons", "20tr"
  const trMatch = t.match(/(\d+(?:\.\d+)?)\s*(?:tr|ton|tons)\b/);
  if (!trMatch) return null;
  const tr = parseFloat(trMatch[1]);

  // condition: t1 or t3 (default null = unspecified)
  let condition = null;
  if (/\bt3\b|46\s*c|46°/.test(t)) condition = "t3";
  else if (/\bt1\b|35\s*c|35°/.test(t)) condition = "t1";

  // default to APMR-A (the registered packaged line with T1/T3 data)
  return { product: "apmr-a", tr, condition };
}

// Apply selection: size up to >= tr, but if the next size down is within 5%
// of the requested tr, offer both.
function selectModel(product, tr, condition) {
  const p = PRODUCTS[product];
  if (!p) return null;
  const key = condition === "t3" ? "t3_tr" : "t1_tr";
  const ordered = [...p.models].sort((a, b) => a[key] - b[key]);

  const safe = ordered.find((m) => m[key] >= tr);
  if (!safe) {
    // larger than the biggest model
    return { kind: "toolarge", product: p, max: ordered[ordered.length - 1] };
  }
  const idx = ordered.indexOf(safe);
  const lower = idx > 0 ? ordered[idx - 1] : null;
  if (lower && lower[key] >= tr * 0.95) {
    return { kind: "both", product: p, lower, upper: safe, condition };
  }
  return { kind: "one", product: p, model: safe, condition };
}

// Build the WhatsApp reply text for a selection result.
function buildSelectionReply(text) {
  const req = parseSelectionRequest(text);
  if (!req) return null;

  const { product, tr, condition } = req;
  const p = PRODUCTS[product];

  // No condition stated -> show nearest model with BOTH T1 and T3, ask condition.
  if (!condition) {
    // nearest by T1 nominal
    const ordered = [...p.models].sort((a, b) => a.t1_tr - b.t1_tr);
    const m = ordered.find((x) => x.t1_tr >= tr) || ordered[ordered.length - 1];
    return (
      `${p.label} around ${tr} TR → model ${m.fullModel}\n` +
      `• T1 (35°C): ${m.t1_tr} TR (${m.t1_kw} kW)\n` +
      `• T3 (46°C): ${m.t3_tr} TR (${m.t3_kw} kW)\n` +
      `• Airflow: ${m.cfm} CFM\n\n` +
      `Tell me the condition — reply "${tr} TR at T1" or "${tr} TR at T3" — for the exact selection.\n` +
      `Reply APMR-A for the full catalogue.`
    );
  }

  const res = selectModel(product, tr, condition);
  const cond = condition.toUpperCase();
  const cTemp = condition === "t3" ? "46°C" : "35°C";
  const tk = condition === "t3" ? "t3_tr" : "t1_tr";
  const kwk = condition === "t3" ? "t3_kw" : "t1_kw";

  if (res.kind === "toolarge") {
    const m = res.max;
    return (
      `For ${tr} TR at ${cond} (${cTemp}), that exceeds the largest APMR-A model.\n` +
      `Biggest: ${m.fullModel} → ${m[tk]} TR (${m[kwk]} kW) at ${cond}.\n` +
      `For higher loads, consider multiple units or a chiller. Reply APMR-A for the catalogue.`
    );
  }

  if (res.kind === "both") {
    const lo = res.lower, hi = res.upper;
    const loShort = Math.round((1 - lo[tk] / tr) * 1000) / 10;
    return (
      `For ${tr} TR at ${cond} (${cTemp}), two close options:\n\n` +
      `• ${lo.fullModel} → ${lo[tk]} TR (${lo[kwk]} kW) — ${loShort}% under, smaller/lower cost\n` +
      `• ${hi.fullModel} → ${hi[tk]} TR (${hi[kwk]} kW) — meets ${tr} TR fully\n\n` +
      `Reply APMR-A for the catalogue with full model data.`
    );
  }

  // one
  const m = res.model;
  const other = condition === "t3" ? "T1 (35°C)" : "T3 (46°C)";
  const otherTr = condition === "t3" ? m.t1_tr : m.t3_tr;
  const otherKw = condition === "t3" ? m.t1_kw : m.t3_kw;
  return (
    `For ${tr} TR at ${cond} (${cTemp}), select: ${m.fullModel}\n` +
    `• ${cond} (${cTemp}): ${m[tk]} TR (${m[kwk]} kW) ✓ meets ${tr} TR\n` +
    `• ${other}: ${otherTr} TR (${otherKw} kW)\n` +
    `• Airflow: ${m.cfm} CFM\n\n` +
    `Reply APMR-A for the data sheet.`
  );
}

// Interpret a bare numeric code (e.g. "52015") and report everything it
// could refer to, so the bot can disambiguate when there's more than one.
// Returns { code, meanings: [ {type, label, action} ] }.
//  - type "pac4a_selection": a fresh-air selection PDF (fetched by filename)
//  - type "apmr_model": a standard packaged model (data in APMR-A catalogue)
// Returns null if the code matches nothing known.
const PAC4A_SELECTION_CODES = [
  "51006", "52008", "52010", "52011", "52013", "52015",
  "52018", "52023", "52025", "52030", "52035", "52040",
];

function interpretCode(text) {
  // Match a standalone 5-digit model code (e.g. 52015), ignoring digits that
  // are part of words like "pac4a" or "apcy-e".
  const m = text.match(/\b(\d{5})\b/);
  const code = m ? m[1] : null;
  if (!code) return null;

  const meanings = [];

  if (PAC4A_SELECTION_CODES.includes(code)) {
    meanings.push({
      type: "pac4a_selection",
      label: `PAC4A ${code} — fresh air unit selection`,
      // fetched as a file by its number
      fetch: code,
    });
  }

  const apmr = PRODUCTS["apmr-a"].models.find((m) => m.code === code);
  if (apmr) {
    meanings.push({
      type: "apmr_model",
      label: `APMR-A ${apmr.t1_tr} TR packaged unit (model ${apmr.fullModel})`,
      // fetched as the APMR-A catalogue
      fetch: "apmr-a",
    });
  }

  if (!meanings.length) return null;
  return { code, meanings };
}

module.exports = {
  PRODUCTS,
  parseSelectionRequest,
  selectModel,
  buildSelectionReply,
  interpretCode,
};
