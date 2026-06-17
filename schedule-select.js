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

module.exports = {
  KW_PER_TR, MBH_PER_KW, COND_POINTS, SPLIT_FAMILY,
  toKw, toTr, toMbh, classifyCategory,
};
