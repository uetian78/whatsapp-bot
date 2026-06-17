// Schedule Image Selection — pure selection logic for the WhatsApp bot.
// Extracts an equipment schedule (image/PDF) into rows, classifies each row,
// and matches Mannai units by capacity. No state; the server owns sessions.

const { rankSplit, FAMILIES } = require("./split-engine.js");
const { PRODUCTS } = require("./products.js");
const { rankModels } = require("./mtz-engine.js");
const { capacityToKw } = require("./vrf/vrfIntake.js");

const EXTRACT_MODEL = process.env.SCHEDULE_EXTRACT_MODEL || "claude-sonnet-4-6";

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

function buildExtractionPrompt() {
  return [
    "You are extracting an HVAC equipment / AC unit schedule. Return ONLY a JSON",
    "array, no prose, no markdown fences. Each element:",
    '{"location": <room/area/tag text or "">,',
    ' "type": <the TYPE cell text exactly as written, e.g. "SPLIT", "PACKAGE AC", "DUCTED">,',
    ' "category": <"split" | "ducted" | "package" — your best read of the unit kind>,',
    ' "capacity": <the SPECIFIED/REQUIRED cooling capacity NUMBER exactly as printed>,',
    ' "unit": <capacity unit EXACTLY as printed: "kW","TR","ton","BTU/HR","MBH","kcal/h"; "" if none>,',
    ' "qty": <integer, default 1>}',
    "Use the SPECIFIED/required capacity, not any competitor 'offered' column.",
    "If the table heading says the units are splits, treat rows as split unless a",
    "row says ducted. Copy the capacity value and unit EXACTLY; do NOT convert.",
    "A cell like '48,000x8' means capacity 48000 and qty 8. Do not invent rows. If",
    "you cannot confidently read a capacity, OMIT that row. Return [] if no schedule.",
  ].join(" ");
}

// Vision JSON -> { rows, skipped }. rows are normalized + classified; skipped
// holds rows we could not read (bad capacity or unknown category).
function normalizeRows(rawArray) {
  const rows = [];
  const skipped = [];
  for (const r of Array.isArray(rawArray) ? rawArray : []) {
    if (!r) continue;
    const category = classifyCategory(r.category || r.type);
    const value = parseFloat(r.capacity);
    if (!category || isNaN(value)) {
      skipped.push({ location: String(r.location || ""), raw: r.type || r.capacity || "" });
      continue;
    }
    const requiredKw = toKw(value, r.unit);
    if (isNaN(requiredKw)) {
      skipped.push({ location: String(r.location || ""), raw: `${r.capacity} ${r.unit || ""}` });
      continue;
    }
    rows.push({
      location: String(r.location || ""),
      type: String(r.type || ""),
      category,
      requiredKw,
      qty: parseInt(r.qty, 10) || 1,
      srcValue: value,
      srcUnit: String(r.unit || ""),
    });
  }
  return { rows, skipped };
}

function summarize(rows) {
  return {
    count: rows.length,
    hasSplit: rows.some((r) => r.category === "split" || r.category === "ducted"),
    hasPackage: rows.some((r) => r.category === "package"),
  };
}

function capStr(kw) {
  return `${toTr(kw).toFixed(1)} TR (${kw.toFixed(1)} kW)`;
}

// Build the final WhatsApp reply. choices: { cond, splitBrand, pkgVendor,
// pkgSeries }. skipped is the verify list from normalizeRows.
function buildReply(rows, skipped, choices) {
  const { cond, splitBrand, pkgVendor, pkgSeries } = choices;
  const rowWord = rows.length === 1 ? "row" : "rows";
  const lines = [`📋 *Schedule Selection* — ${rows.length} ${rowWord} · rated at ${cond}`];

  const pkgRows = rows.filter((r) => r.category === "package");
  const splitRows = rows.filter((r) => r.category === "split" || r.category === "ducted");

  if (pkgRows.length) {
    const vendorLabel = pkgVendor === "trane" ? "Trane MTZ"
      : `SKM ${pkgSeries === "apmr-a" ? "APMR-A" : "APMR"}`;
    lines.push("", `🏢 *PACKAGE (${vendorLabel})*`);
    for (const r of pkgRows) {
      if (pkgVendor === "trane") {
        const m = matchPackageTrane(r.requiredKw, cond);
        const flag = m.adequate ? "✅" : "⚠️ undersized";
        lines.push(`• ${r.location} — req ${capStr(r.requiredKw)} ×${r.qty}`,
          `   → MTZ ${m.key} · ${m.tons} TR · ${flag} _(rated indoor 80/67°F)_`);
      } else {
        const m = matchPackageSkm(r.requiredKw, pkgSeries, cond);
        const name = `${m.series === "apmr-a" ? "APMR-A" : "APMR"} ${m.code}`;
        const tags = [];
        if (m.fellBack) tags.push("↪ APMR-A (APMR range exceeded)");
        tags.push(m.adequate ? "✅" : "⚠️ undersized");
        lines.push(`• ${r.location} — req ${capStr(r.requiredKw)} ×${r.qty}`,
          `   → ${name} · ${m.capKw.toFixed(1)} kW ${cond} · ${tags.join(" · ")}`);
      }
    }
  }

  if (splitRows.length) {
    const BRAND_DISPLAY = { toshiba: "Toshiba", tcl: "TCL", skm: "SKM" };
    const brandTitle = BRAND_DISPLAY[splitBrand] || (splitBrand.charAt(0).toUpperCase() + splitBrand.slice(1));
    lines.push("", `❄️ *SPLIT (${brandTitle})*`);
    for (const r of splitRows) {
      const famKey = splitFamilyKey(splitBrand, r.category);
      if (!famKey) {
        lines.push(`• ${r.location} — req ${capStr(r.requiredKw)} ×${r.qty}`,
          `   → ⚠️ ${brandTitle} ${r.category} not in catalogue — verify`);
        continue;
      }
      const m = matchSplit(r.requiredKw, famKey, cond);
      if (!m) {
        lines.push(`• ${r.location} — req ${capStr(r.requiredKw)} ×${r.qty}`,
          `   → ⚠️ ${brandTitle} ${r.category} — selection error, verify`);
        continue;
      }
      const flag = m.adequate ? "✅" : "⚠️ undersized";
      const kind = r.category === "ducted" ? "ducted" : "hi-wall";
      lines.push(`• ${r.location} (${kind}) — req ${capStr(r.requiredKw)} ×${r.qty}`,
        `   → ${m.label} · ${m.capKw.toFixed(1)} kW ${cond} · ${flag}`);
    }
  }

  if (skipped && skipped.length) {
    lines.push("", `⚠️ *Verify: ${skipped.length} row(s) couldn't be read*`);
    for (const s of skipped) lines.push(`• ${s.location || s.raw || "(unreadable)"}`);
  }
  return lines.join("\n");
}

// Send an image/PDF to Claude vision and return normalized { rows, skipped }.
async function rowsFromScheduleImage(base64Data, mediaType) {
  const isPdf = mediaType === "application/pdf";
  const block = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: EXTRACT_MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content: [block, { type: "text", text: buildExtractionPrompt() }] }],
    }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch (_) {}
    throw new Error(`schedule extraction API ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text").map((b) => b.text).join("")
    .replace(/```json|```/g, "").trim();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (_) { throw new Error("Could not parse the schedule. Try a clearer photo or PDF."); }
  if (!Array.isArray(parsed)) throw new Error("Schedule extractor returned an unexpected format. Please try again.");
  return normalizeRows(parsed);
}

module.exports = {
  KW_PER_TR, MBH_PER_KW, COND_POINTS, SPLIT_FAMILY,
  toKw, toTr, toMbh, classifyCategory,
  splitFamilyKey, matchSplit,
  matchPackageSkm, matchPackageTrane,
  buildExtractionPrompt, normalizeRows,
  summarize, buildReply, rowsFromScheduleImage,
};
