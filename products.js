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
    refrigerant: "R-410A",
    fileKeyword: "apmr-a",
    selectBy: "tr",
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

  // APMR Packaged Air Conditioners (R-410A) — 5 to 28 TR
  "apmr": {
    label: "APMR Packaged Air Conditioner",
    refrigerant: "R-410A",
    fileKeyword: "apmr",
    namePrefix: "APMR ",
    selectBy: "tr",
    models: [
      { code: "51050", cfm: 1670, t1_kw: 15.6, t3_kw: 13.9 },
      { code: "51060", cfm: 2000, t1_kw: 17.3, t3_kw: 15.4 },
      { code: "51075", cfm: 2400, t1_kw: 21.8, t3_kw: 19.5 },
      { code: "51080", cfm: 2900, t1_kw: 23.6, t3_kw: 20.7 },
      { code: "51100", cfm: 3220, t1_kw: 28.9, t3_kw: 25.7 },
      { code: "52115", cfm: 4000, t1_kw: 33.3, t3_kw: 29.3 },
      { code: "52125", cfm: 4000, t1_kw: 35.2, t3_kw: 31.3 },
      { code: "52150", cfm: 5000, t1_kw: 44.1, t3_kw: 39.4 },
      { code: "52170", cfm: 6000, t1_kw: 49.3, t3_kw: 43.8 },
      { code: "52200", cfm: 7000, t1_kw: 57.0, t3_kw: 50.7 },
      { code: "52230", cfm: 7000, t1_kw: 66.6, t3_kw: 58.1 },
      { code: "52240", cfm: 8000, t1_kw: 68.5, t3_kw: 60.6 },
      { code: "52270", cfm: 8000, t1_kw: 77.5, t3_kw: 67.1 },
      { code: "52300", cfm: 9100, t1_kw: 87.8, t3_kw: 76.2 },
      { code: "52340", cfm: 10500, t1_kw: 98.9, t3_kw: 87.6 },
    ],
  },
};

// compute TR for each model once
for (const key of Object.keys(PRODUCTS)) {
  const prefix = PRODUCTS[key].namePrefix || "APMR ";
  const suffix = key === "apmr-a" ? "A" : "";
  for (const m of PRODUCTS[key].models) {
    m.t1_tr = Math.round((m.t1_kw / TR_KW) * 10) / 10;
    m.t3_tr = Math.round((m.t3_kw / TR_KW) * 10) / 10;
    m.fullModel = `${prefix}${m.code}${suffix}`;
  }
}

// Parse a free-text request like:
//   "package unit 20 tr t3", "apmr-a 20 ton", "20 tr at t3 packaged"
// Returns { product, tr, condition } or null.
function parseSelectionRequest(text) {
  const t = text.toLowerCase();

  // Fresh-air / DOAS requests belong to PAC4A, not the standard packaged lines.
  const isFreshAir = /\bfresh air\b|\bdoas\b|\bpac4a\b|outside air|100% fresh/.test(t);
  if (isFreshAir) return null; // let folder/AI handle PAC4A for now

  // must look like a packaged-unit request
  const isPackaged =
    /\bapmr\b|\bapmr-?a\b|packaged|package unit|package ac/.test(t);
  if (!isPackaged) return null;

  // CFM: "5000 cfm", "5000cfm"
  const cfmMatch = t.match(/(\d{3,6})\s*cfm\b/);
  // tonnage: "20 tr", "20 ton", "20 tons", "20tr"
  const trMatch = t.match(/(\d+(?:\.\d+)?)\s*(?:tr|ton|tons)\b/);

  // condition: t1 or t3 (default null = unspecified)
  let condition = null;
  if (/\bt3\b|46\s*c|46°/.test(t)) condition = "t3";
  else if (/\bt1\b|35\s*c|35°/.test(t)) condition = "t1";

  // Determine which packaged line is named (if any)
  let named = null;
  if (/\bapmr-?a\b|\bapmra\b/.test(t)) named = "apmr-a";
  else if (/\bapmr\b/.test(t)) named = "apmr";

  // CFM request takes priority if present (airflow selection, no T1/T3 needed)
  if (cfmMatch) {
    const cfm = parseInt(cfmMatch[1], 10);
    let product = named;
    if (!product) {
      // plain: prefer APMR if CFM within its range, else APMR-A
      const apmrMaxCfm = Math.max(...PRODUCTS["apmr"].models.map((m) => m.cfm));
      product = cfm <= apmrMaxCfm ? "apmr" : "apmr-a";
    }
    return { mode: "cfm", product, cfm };
  }

  // Otherwise tonnage request
  if (!trMatch) return null;
  const tr = parseFloat(trMatch[1]);

  let product = named;
  if (!product) {
    const condKey = condition === "t3" ? "t3_tr" : "t1_tr";
    const apmrMax = Math.max(...PRODUCTS["apmr"].models.map((m) => m[condKey]));
    product = tr <= apmrMax ? "apmr" : "apmr-a";
  }

  return { mode: "tr", product, tr, condition };
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

// CFM selection: smallest CFM >= requested. If multiple models share that CFM,
// return all of them. If the next CFM down is within 5%, include those too.
function selectByCfm(product, cfm) {
  const p = PRODUCTS[product];
  if (!p) return null;
  const cfms = [...new Set(p.models.map((m) => m.cfm))].sort((a, b) => a - b);

  const safeCfm = cfms.find((c) => c >= cfm);
  if (safeCfm === undefined) {
    const maxCfm = cfms[cfms.length - 1];
    const max = p.models.filter((m) => m.cfm === maxCfm);
    return { kind: "toolarge", product: p, max };
  }

  // models at the chosen CFM
  let chosen = p.models.filter((m) => m.cfm === safeCfm);

  // include next CFM down if within 5%
  const idx = cfms.indexOf(safeCfm);
  if (idx > 0) {
    const lowerCfm = cfms[idx - 1];
    if (lowerCfm >= cfm * 0.95) {
      chosen = chosen.concat(p.models.filter((m) => m.cfm === lowerCfm));
    }
  }
  return { kind: "models", product: p, cfm, models: chosen };
}

// Build the WhatsApp reply text for a selection result.
function buildSelectionReply(text) {
  const req = parseSelectionRequest(text);
  if (!req || req.mode !== "tr") return null;

  const { product, tr, condition } = req;
  const p = PRODUCTS[product];
  const cat = product === "apmr-a" ? "APMR-A" : "APMR"; // catalogue keyword to reply with

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
      `Reply ${cat} for the full catalogue.`
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
      `For ${tr} TR at ${cond} (${cTemp}), that exceeds the largest ${cat} model.\n` +
      `Biggest: ${m.fullModel} → ${m[tk]} TR (${m[kwk]} kW) at ${cond}.\n` +
      `For higher loads, consider multiple units or a chiller. Reply ${cat} for the catalogue.`
    );
  }

  if (res.kind === "both") {
    const lo = res.lower, hi = res.upper;
    const loShort = Math.round((1 - lo[tk] / tr) * 1000) / 10;
    return (
      `For ${tr} TR at ${cond} (${cTemp}), two close options:\n\n` +
      `• ${lo.fullModel} → ${lo[tk]} TR (${lo[kwk]} kW) — ${loShort}% under, smaller/lower cost\n` +
      `• ${hi.fullModel} → ${hi[tk]} TR (${hi[kwk]} kW) — meets ${tr} TR fully\n\n` +
      `Reply ${cat} for the catalogue with full model data.`
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
    `Reply ${cat} for the data sheet.`
  );
}

// Build an INTERACTIVE WhatsApp response (text + reply buttons) for a
// selection request. Returns { text, buttons: [{id,title}] } or null.
// Button IDs encode the action:
//   "cond|<product>|<tr>|t1"  -> re-run selection at T1
//   "cond|<product>|<tr>|t3"  -> re-run selection at T3
//   "sheet|<fullModel>"        -> send that model's data sheet PDF
function buildSelectionInteractive(text) {
  const req = parseSelectionRequest(text);
  if (!req) return null;
  if (req.mode === "cfm") return interactiveForCfm(req.product, req.cfm);
  return interactiveFor(req.product, req.tr, req.condition);
}

// CFM selection -> buttons (one per matching model, max 3).
function interactiveForCfm(product, cfm) {
  const p = PRODUCTS[product];
  if (!p) return null;
  const cat = product === "apmr-a" ? "APMR-A" : "APMR";

  const res = selectByCfm(product, cfm);
  if (!res) return null;

  if (res.kind === "toolarge") {
    const big = res.max[0];
    return {
      text:
        `${cfm} CFM is above the largest ${cat} model (${big.cfm} CFM).\n` +
        `For higher airflow, consider a larger unit or an AHU.`,
      buttons: [{ id: `sheet|${big.fullModel}`, title: `${big.code} sheet` }],
    };
  }

  const models = res.models;
  const lines = models
    .map((m) => `• ${m.fullModel} → ${m.cfm} CFM, ${m.t1_tr} TR (T1) / ${m.t3_tr} TR (T3)`)
    .join("\n");
  const header =
    models.length === 1
      ? `For ${cfm} CFM: ${models[0].fullModel}`
      : `For ${cfm} CFM, ${models.length} options:`;
  return {
    text: `${header}\n${lines}\n\nTap a model for its data sheet:`,
    buttons: models.slice(0, 3).map((m) => ({
      id: `sheet|${m.fullModel}`,
      title: `${m.code} (${m.cfm}cfm)`,
    })),
  };
}

// Core builder reused by both text requests and button taps.
function interactiveFor(product, tr, condition) {
  const p = PRODUCTS[product];
  if (!p) return null;
  const cat = product === "apmr-a" ? "APMR-A" : "APMR";

  // No condition -> offer T1 / T3 buttons.
  if (!condition) {
    const ordered = [...p.models].sort((a, b) => a.t1_tr - b.t1_tr);
    const m = ordered.find((x) => x.t1_tr >= tr) || ordered[ordered.length - 1];
    return {
      text:
        `${p.label} around ${tr} TR.\n` +
        `Which design condition?\n\n` +
        `• T1 = 35°C ambient\n` +
        `• T3 = 46°C ambient`,
      buttons: [
        { id: `cond|${product}|${tr}|t1`, title: "T1 (35°C)" },
        { id: `cond|${product}|${tr}|t3`, title: "T3 (46°C)" },
      ],
    };
  }

  const res = selectModel(product, tr, condition);
  const cond = condition.toUpperCase();
  const cTemp = condition === "t3" ? "46°C" : "35°C";
  const tk = condition === "t3" ? "t3_tr" : "t1_tr";
  const kwk = condition === "t3" ? "t3_kw" : "t1_kw";

  if (res.kind === "toolarge") {
    const m = res.max;
    return {
      text:
        `For ${tr} TR at ${cond} (${cTemp}), that's above the largest ${cat} model.\n` +
        `Biggest: ${m.fullModel} → ${m[tk]} TR (${m[kwk]} kW).\n` +
        `For higher loads, consider multiple units or a chiller.`,
      buttons: [{ id: `sheet|${m.fullModel}`, title: `${m.code} sheet` }],
    };
  }

  if (res.kind === "both") {
    const lo = res.lower, hi = res.upper;
    const loShort = Math.round((1 - lo[tk] / tr) * 1000) / 10;
    return {
      text:
        `For ${tr} TR at ${cond} (${cTemp}), two close options:\n\n` +
        `• ${lo.fullModel} → ${lo[tk]} TR (${lo[kwk]} kW) — ${loShort}% under\n` +
        `• ${hi.fullModel} → ${hi[tk]} TR (${hi[kwk]} kW) — meets ${tr} TR\n\n` +
        `Tap a model for its data sheet:`,
      buttons: [
        { id: `sheet|${lo.fullModel}`, title: `${lo.code} (${lo[tk]}TR)` },
        { id: `sheet|${hi.fullModel}`, title: `${hi.code} (${hi[tk]}TR)` },
      ],
    };
  }

  // one
  const m = res.model;
  const other = condition === "t3" ? "T1 (35°C)" : "T3 (46°C)";
  const otherTr = condition === "t3" ? m.t1_tr : m.t3_tr;
  const otherKw = condition === "t3" ? m.t1_kw : m.t3_kw;
  return {
    text:
      `For ${tr} TR at ${cond} (${cTemp}): ${m.fullModel}\n` +
      `• ${cond} (${cTemp}): ${m[tk]} TR (${m[kwk]} kW) ✓\n` +
      `• ${other}: ${otherTr} TR (${otherKw} kW)\n` +
      `• Airflow: ${m.cfm} CFM`,
    buttons: [{ id: `sheet|${m.fullModel}`, title: `${m.code} data sheet` }],
  };
}

// Handle a button tap. Returns either:
//   { type: "interactive", text, buttons }  -> another button message
//   { type: "sheet", fileName }             -> fetch this PDF from Drive
//   null                                     -> not one of our buttons
function handleButtonTap(buttonId) {
  if (!buttonId) return null;
  const parts = buttonId.split("|");

  if (parts[0] === "cond") {
    const [, product, trStr, condition] = parts;
    const tr = parseFloat(trStr);
    const out = interactiveFor(product, tr, condition);
    return out ? { type: "interactive", ...out } : null;
  }

  if (parts[0] === "sheet") {
    const fullModel = parts.slice(1).join("|"); // e.g. "APMR-A 52025"
    return { type: "sheet", fileName: fullModel };
  }

  return null;
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
  buildSelectionInteractive,
  handleButtonTap,
  interpretCode,
};
