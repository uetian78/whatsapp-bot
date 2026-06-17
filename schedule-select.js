// Schedule Image Selection — pure selection logic for the WhatsApp bot.
// Extracts an equipment schedule (image/PDF) into rows, classifies each row,
// and matches Mannai units by capacity. No state; the server owns sessions.

const { rankSplit, FAMILIES } = require("./split-engine.js");
const { PRODUCTS } = require("./products.js");
const { rankModels } = require("./mtz-engine.js");
const { capacityToKw } = require("./vrf/vrfIntake.js");

const KW_PER_TR = 3.51685;
const MBH_PER_KW = 3.412142;

// Outdoor/indoor rating points + Fahrenheit ambient per condition.
const COND_POINTS = {
  T1: { idb: 27, iwb: 19, odb: 35, ambF: 95 },
  T3: { idb: 29, iwb: 19, odb: 46, ambF: 115 },
};

// brand -> { hiwall, ducted } family keys. null = unsupported.
const SPLIT_FAMILY = {
  toshiba: { hiwall: "PKV", ducted: "BSP" },
  tcl: { hiwall: "TCL-HW", ducted: null },
  skm: { hiwall: "SKM-HW", ducted: "SKM-DCT" },
};

function toKw(value, unitHint) {
  const conv = capacityToKw(parseFloat(value), `${unitHint || ""} ${value}`);
  return conv.kw;
}
function toTr(kw) { return kw / KW_PER_TR; }
function toMbh(kw) { return kw * MBH_PER_KW; }

// Map a free-text TYPE cell to a category enum. package > ducted > split.
function classifyCategory(text) {
  const t = String(text || "").toLowerCase();
  if (/package|floor\s*stand|roof\s*top|rooftop|packaged/.test(t)) return "package";
  if (/duct/.test(t)) return "ducted";
  if (/split|hi[\s-]?wall|high[\s-]?wall|wall|cassette/.test(t)) return "split";
  return null;
}

function splitFamilyKey(brand, category) {
  const b = SPLIT_FAMILY[String(brand || "").toLowerCase()];
  if (!b) return null;
  return category === "ducted" ? b.ducted : b.hiwall;
}

// Match a load (kW) against a split family at the given condition.
// Returns { label, capKw, marginPct, adequate } or null if family unknown.
function matchSplit(loadKw, famKey, cond) {
  if (!FAMILIES[famKey]) return null;
  const p = COND_POINTS[cond];
  const ranked = rankSplit(famKey, loadKw, p.idb, p.iwb, p.odb, cond, 0);
  if (!ranked.length) return null;
  const best = ranked[0]; // adequate-first, then smallest adequate
  return {
    label: best.label,
    capKw: best.tc,
    marginPct: Math.round((best.margin || 0) * 100),
    adequate: !!best.adequate,
  };
}

// SKM package match against APMR, with auto fall-back to APMR-A when the load
// exceeds the APMR range. seriesKey is "apmr" or "apmr-a".
function matchPackageSkm(loadKw, seriesKey, cond) {
  if (!COND_POINTS[cond]) throw new RangeError(`matchPackageSkm: unknown condition "${cond}"`);
  const field = cond === "T1" ? "t1_kw" : "t3_kw";
  const pick = (key) => {
    const models = [...PRODUCTS[key].models].sort((a, b) => a[field] - b[field]);
    const m = models.find((x) => x[field] >= loadKw);
    return m ? { code: m.code, capKw: m[field] } : null;
  };
  let series = seriesKey;
  let hit = pick(seriesKey);
  let fellBack = false;
  if (!hit && seriesKey === "apmr") {
    series = "apmr-a";
    fellBack = true;
    const a = pick("apmr-a");
    if (a) hit = a;
  }
  if (!hit) {
    const models = [...PRODUCTS[series].models].sort((a, b) => a[field] - b[field]);
    const max = models[models.length - 1];
    return { series, code: max.code, capKw: max[field], adequate: false, fellBack };
  }
  return { series, code: hit.code, capKw: hit.capKw, adequate: true, fellBack };
}

// Trane MTZ package match. Indoor rated DB80/WB67 assumed; ambient from cond.
function matchPackageTrane(loadKw, cond) {
  if (!COND_POINTS[cond]) throw new RangeError(`matchPackageTrane: unknown condition "${cond}"`);
  const reqTC = toMbh(loadKw);
  const amb = COND_POINTS[cond].ambF;
  const ranked = rankModels(reqTC, 0, 80, 67, amb);
  const best = ranked[0];
  return { key: best.key, tons: best.tons, tcMbh: best.r.TC, adequate: !!best.adequate };
}

module.exports = {
  KW_PER_TR, MBH_PER_KW, COND_POINTS, SPLIT_FAMILY,
  toKw, toTr, toMbh, classifyCategory,
  splitFamilyKey, matchSplit,
  matchPackageSkm, matchPackageTrane,
};
