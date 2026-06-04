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

  // PAC4A 100% Fresh Air (DOAS) units (R-410A) — single condition (46.1C).
  // capacity = "Actual Capacity" at 46.1C entering/ambient. No T1/T3 split.
  "pac4a": {
    label: "PAC4A 100% Fresh Air Unit",
    refrigerant: "R-410A",
    fileKeyword: "pac4a",
    namePrefix: "PAC4A ",
    selectBy: "fresh", // single-condition capacity
    models: [
      { code: "51006", cfm: 600, cap_kw: 16.1 },
      { code: "52008", cfm: 1200, cap_kw: 27.4 },
      { code: "52010", cfm: 1200, cap_kw: 31.7 },
      { code: "52011", cfm: 1600, cap_kw: 36.5 },
      { code: "52013", cfm: 1800, cap_kw: 43.4 },
      { code: "52015", cfm: 2200, cap_kw: 55.5 },
      { code: "52018", cfm: 2600, cap_kw: 63.0 },
      { code: "52020", cfm: 3200, cap_kw: 71.3 },
      { code: "52023", cfm: 3200, cap_kw: 77.1 },
      { code: "52025", cfm: 3400, cap_kw: 86.1 },
      { code: "52030", cfm: 4400, cap_kw: 108.5 },
      { code: "52035", cfm: 4400, cap_kw: 116.9 },
      { code: "52040", cfm: 5400, cap_kw: 136.4 },
    ],
  },
};

// compute TR for each model once
for (const key of Object.keys(PRODUCTS)) {
  const prefix = PRODUCTS[key].namePrefix || "APMR ";
  const suffix = key === "apmr-a" ? "A" : "";
  for (const m of PRODUCTS[key].models) {
    if (m.cap_kw !== undefined) {
      // single-condition product (PAC4A)
      m.cap_tr = Math.round((m.cap_kw / TR_KW) * 10) / 10;
    } else {
      m.t1_tr = Math.round((m.t1_kw / TR_KW) * 10) / 10;
      m.t3_tr = Math.round((m.t3_kw / TR_KW) * 10) / 10;
    }
    m.fullModel = `${prefix}${m.code}${suffix}`;
  }
}

// Parse a free-text request like:
//   "package unit 20 tr t3", "apmr-a 20 ton", "20 tr at t3 packaged"
// Returns { product, tr, condition } or null.
function parseSelectionRequest(text) {
  const t = text.toLowerCase();

  // CFM and tonnage extraction (shared)
  const cfmMatch = t.match(/(\d{3,6})\s*cfm\b/);
  const trMatch = t.match(/(\d+(?:\.\d+)?)\s*(?:tr|ton|tons)\b/);

  // Fresh-air / DOAS requests -> PAC4A (single condition, no T1/T3).
  const isFreshAir = /\bfresh air\b|\bdoas\b|\bpac4a\b|outside air|100% fresh/.test(t);
  if (isFreshAir) {
    if (cfmMatch) return { mode: "fresh-cfm", product: "pac4a", cfm: parseInt(cfmMatch[1], 10) };
    if (trMatch) return { mode: "fresh-tr", product: "pac4a", tr: parseFloat(trMatch[1]) };
    return null; // fresh air mentioned but no number -> let folder/AI handle
  }

  // must look like a packaged-unit request
  const isPackaged =
    /\bapmr\b|\bapmr-?a\b|packaged|package unit|package ac/.test(t);
  if (!isPackaged) return null;

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

// PAC4A single-condition selection by capacity (TR). Size up; 5% show-both.
function selectFreshByTr(tr) {
  const p = PRODUCTS["pac4a"];
  const ordered = [...p.models].sort((a, b) => a.cap_tr - b.cap_tr);
  const safe = ordered.find((m) => m.cap_tr >= tr);
  if (!safe) return { kind: "toolarge", product: p, max: ordered[ordered.length - 1] };
  const idx = ordered.indexOf(safe);
  const lower = idx > 0 ? ordered[idx - 1] : null;
  if (lower && lower.cap_tr >= tr * 0.95) {
    return { kind: "both", product: p, lower, upper: safe };
  }
  return { kind: "one", product: p, model: safe };
}

// PAC4A single-condition selection by CFM. Size up; show all at matching CFM; 5%.
function selectFreshByCfm(cfm) {
  const p = PRODUCTS["pac4a"];
  const cfms = [...new Set(p.models.map((m) => m.cfm))].sort((a, b) => a - b);
  const safeCfm = cfms.find((c) => c >= cfm);
  if (safeCfm === undefined) {
    const maxCfm = cfms[cfms.length - 1];
    return { kind: "toolarge", product: p, max: p.models.filter((m) => m.cfm === maxCfm) };
  }
  let chosen = p.models.filter((m) => m.cfm === safeCfm);
  const idx = cfms.indexOf(safeCfm);
  if (idx > 0 && cfms[idx - 1] >= cfm * 0.95) {
    chosen = chosen.concat(p.models.filter((m) => m.cfm === cfms[idx - 1]));
  }
  return { kind: "models", product: p, cfm, models: chosen };
}

// Build the WhatsApp reply text for a selection result (legacy text fallback).
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
  if (req.mode === "fresh-cfm") return interactiveForFreshCfm(req.cfm);
  if (req.mode === "fresh-tr") return interactiveForFreshTr(req.tr);
  return interactiveFor(req.product, req.tr, req.condition);
}

// PAC4A fresh-air selection by capacity (TR) -> buttons.
function interactiveForFreshTr(tr) {
  const res = selectFreshByTr(tr);
  if (res.kind === "toolarge") {
    const m = res.max;
    return {
      text:
        `For ${tr} TR fresh air, that's above the largest PAC4A model.\n` +
        `Biggest: ${m.fullModel} → ${m.cap_tr} TR (${m.cap_kw} kW) at 46°C.`,
      buttons: [{ id: `sheet|${m.fullModel}`, title: `${m.code} sheet` }],
    };
  }
  if (res.kind === "both") {
    const lo = res.lower, hi = res.upper;
    const loShort = Math.round((1 - lo.cap_tr / tr) * 1000) / 10;
    return {
      text:
        `For ${tr} TR fresh air (at 46°C), two close options:\n\n` +
        `• ${lo.fullModel} → ${lo.cap_tr} TR (${lo.cap_kw} kW) — ${loShort}% under\n` +
        `• ${hi.fullModel} → ${hi.cap_tr} TR (${hi.cap_kw} kW) — meets ${tr} TR\n\n` +
        `Tap a model for its data sheet:`,
      buttons: [
        { id: `sheet|${lo.fullModel}`, title: `${lo.code} (${lo.cap_tr}TR)` },
        { id: `sheet|${hi.fullModel}`, title: `${hi.code} (${hi.cap_tr}TR)` },
      ],
    };
  }
  const m = res.model;
  return {
    text:
      `For ${tr} TR fresh air: ${m.fullModel}\n` +
      `• Capacity at 46°C: ${m.cap_tr} TR (${m.cap_kw} kW) ✓\n` +
      `• Airflow: ${m.cfm} CFM`,
    buttons: [{ id: `sheet|${m.fullModel}`, title: `${m.code} data sheet` }],
  };
}

// PAC4A fresh-air selection by CFM -> buttons.
function interactiveForFreshCfm(cfm) {
  const res = selectFreshByCfm(cfm);
  if (res.kind === "toolarge") {
    const big = res.max[0];
    return {
      text:
        `${cfm} CFM is above the largest PAC4A model (${big.cfm} CFM).\n` +
        `For higher fresh-air volumes, consider multiple units.`,
      buttons: [{ id: `sheet|${big.fullModel}`, title: `${big.code} sheet` }],
    };
  }
  const models = res.models;
  const lines = models
    .map((m) => `• ${m.fullModel} → ${m.cfm} CFM, ${m.cap_tr} TR (${m.cap_kw} kW)`)
    .join("\n");
  const header =
    models.length === 1
      ? `For ${cfm} CFM fresh air: ${models[0].fullModel}`
      : `For ${cfm} CFM fresh air, ${models.length} options:`;
  return {
    text: `${header}\n${lines}\n\nTap a model for its data sheet:`,
    buttons: models.slice(0, 3).map((m) => ({
      id: `sheet|${m.fullModel}`,
      title: `${m.code} (${m.cfm}cfm)`,
    })),
  };
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

  // Catalogue / IOM choice for a series: "doc|<series>|<docType>"
  if (parts[0] === "doc") {
    const series = parts[1];
    const docType = parts[2]; // "Catalogue" or "IOM"
    return {
      type: "folderFile",
      folder: docType,             // search ONLY this folder
      fileName: `${series} ${docType}`, // e.g. "APMR Catalogue"
      series,
      docType,
    };
  }

  return null;
}

// ============================================================
//  SERIES -> CATALOGUE / IOM  FLOW
//  When a user types a product SERIES name (e.g. "APMR", "APCY-P"),
//  the bot asks whether they want the Catalogue or the IOM, then
//  fetches the PDF from the matching folder ONLY.
//
//  If the user already says the type too (e.g. "APMR IOM",
//  "apmra catalogue"), we skip the menu and fetch directly.
//
//  Files are expected to be named, inside their folder, as:
//     Catalogue folder:  "<SERIES> Catalogue.pdf"   e.g. "APMR Catalogue.pdf"
//     IOM folder:        "<SERIES> IOM.pdf"          e.g. "APMR-A IOM.pdf"
// ============================================================

// Canonical series the bot knows about. `aliases` are everything a user
// might type; `name` is the canonical label used to build the filename.
// Order matters: longer / more specific names first so "apmr-a" is tested
// before "apmr" and "apcy-p" before a hypothetical bare "apcy".
const SERIES = [
  { name: "APMR-A", aliases: ["apmr-a", "apmra", "apmr a"] },
  { name: "APMR-V", aliases: ["apmr-v", "apmrv", "apmr v"] },
  { name: "APMR",   aliases: ["apmr"] },
  { name: "AUMR-A", aliases: ["aumr-a", "aumra", "aumr a", "aumr"] },
  { name: "PAC4A",  aliases: ["pac4a", "pac 4a", "pac-4a"] },
  { name: "APCY-P", aliases: ["apcy-p", "apcyp", "apcy p"] },
  { name: "APCY-H", aliases: ["apcy-h", "apcyh", "apcy h"] },
  { name: "APCY-E", aliases: ["apcy-e", "apcye", "apcy e"] },
  { name: "APCN-S", aliases: ["apcn-s", "apcns", "apcn s"] },
  { name: "APCN-VVH", aliases: ["apcn-vvh", "apcnvvh", "apcn vvh"] },
  { name: "APCNVZ", aliases: ["apcnvz", "apcn-vz", "apcn vz"] },
  { name: "ACMR",   aliases: ["acmr"] },
  { name: "ACUV-D", aliases: ["acuv-d", "acuvd", "acuv d"] },
  { name: "ACUV-S", aliases: ["acuv-s", "acuvs", "acuv s"] },
  { name: "ACUS",   aliases: ["acus"] },
  { name: "CRAC",   aliases: ["crac"] },
  { name: "CAH",    aliases: ["cah"] },
  { name: "MAH",    aliases: ["mah"] },
  { name: "SKM FCU", aliases: ["skm fcu", "fcu", "fan coil", "fan coil unit"] },
];

// Detect whether the text asks for a specific document type.
// Returns "Catalogue", "IOM", or null.
function detectDocType(text) {
  const t = text.toLowerCase();
  if (/\biom\b|installation|operation|maintenance|o&m|o & m|manual/.test(t)) return "IOM";
  if (/\bcatalogue\b|\bcatalog\b|\bcatalouge\b|\bbrochure\b/.test(t)) return "Catalogue";
  return null;
}

// Find which series (if any) the text names. Returns the canonical series
// name (e.g. "APMR-A") or null. Matches whole-word aliases so "apmr" inside
// "apmra" doesn't false-trigger (longer aliases are tested first).
function detectSeries(text) {
  const t = ` ${text.toLowerCase().trim()} `;
  for (const s of SERIES) {
    for (const a of s.aliases) {
      // word-boundary-ish match: surrounded by start/space/punct
      const re = new RegExp(`(^|[\\s,.])${a.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}([\\s,.]|$)`);
      if (re.test(t)) return s.name;
    }
  }
  return null;
}

// Main entry for the series flow. Given the user's raw text, decide:
//   - { mode: "direct", series, docType }  -> fetch "<series> <docType>.pdf"
//        (user typed both, e.g. "APMR IOM")
//   - { mode: "menu", series }             -> ask Catalogue or IOM
//        (user typed just the series, e.g. "APMR")
//   - null                                 -> not a series request
//
// Guard: if the text also contains a capacity/CFM/model number, this is a
// SELECTION request, not a plain catalogue/IOM request, so we return null and
// let the selection logic handle it.
function parseSeriesRequest(text) {
  const t = text.toLowerCase();

  // If there's a tonnage, CFM, or a 5-digit model code, it's a selection
  // request (handled elsewhere), not a catalogue/IOM request.
  if (/\d{3,6}\s*cfm\b/.test(t)) return null;
  if (/\d+(?:\.\d+)?\s*(?:tr|ton|tons)\b/.test(t)) return null;
  if (/\b\d{5}\b/.test(t)) return null;

  const series = detectSeries(text);
  if (!series) return null;

  const docType = detectDocType(text);
  if (docType) return { mode: "direct", series, docType };
  return { mode: "menu", series };
}

// Build the interactive Catalogue / IOM button message for a series.
function seriesMenu(series) {
  return {
    text:
      `${series} — which document would you like?\n\n` +
      `• Catalogue (technical data, model range)\n` +
      `• IOM (installation, operation & maintenance)`,
    buttons: [
      { id: `doc|${series}|Catalogue`, title: "Catalogue" },
      { id: `doc|${series}|IOM`, title: "IOM" },
    ],
  };
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
  parseSeriesRequest,
  seriesMenu,
  detectSeries,
  detectDocType,
};
