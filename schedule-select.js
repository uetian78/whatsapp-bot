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
function lsToCfm(v) { return v * 2.11888; }
function cToF(c) { return c * 9 / 5 + 32; }

// token wins; else map ambient °C to T1/T3; unrecognized → null (never guess)
function parseCondition(token, ambientC) {
  const t = String(token || "").trim().toUpperCase();
  if (t === "T1" || t === "T3") return t;
  const a = parseFloat(ambientC);
  if (!isNaN(a)) {
    if (a >= 42) return "T3";
    if (a >= 30) return "T1";
  }
  return null;
}

function numOrNull(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// When the single largest available unit still falls short of the load,
// propose N of that unit in parallel instead of flagging "undersized".
// Returns qty=1 (no change) whenever one unit already covers the load.
function unitsToMeetLoad(loadKw, unitCapKw) {
  const qty = Math.max(1, Math.ceil(loadKw / unitCapKw));
  return { qty, totalCapKw: qty * unitCapKw };
}

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
function matchSplit(loadKw, famKey, cond, onCoil = null) {
  if (!FAMILIES[famKey]) return null;
  const p = COND_POINTS[cond];
  const hasOC = !!(onCoil && onCoil.db != null && onCoil.wb != null);
  const idb = hasOC ? onCoil.db : p.idb;
  const iwb = hasOC ? onCoil.wb : p.iwb;
  const ranked = rankSplit(famKey, loadKw, idb, iwb, p.odb, cond, 0);
  if (!ranked.length) return null;
  // adequate-first, then smallest adequate; if none adequate, the largest model.
  const best = ranked[0];
  const { qty, totalCapKw } = unitsToMeetLoad(loadKw, best.tc);
  return {
    label: best.label,
    capKw: best.tc,
    marginPct: Math.round((best.margin || 0) * 100),
    adequate: !!best.adequate,
    usedOnCoil: hasOC,
    unitsNeeded: qty,
    proposedKw: totalCapKw,
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
    const { qty, totalCapKw } = unitsToMeetLoad(loadKw, max[field]);
    return { series, code: max.code, capKw: max[field], adequate: true, fellBack,
             unitsNeeded: qty, proposedKw: totalCapKw };
  }
  return { series, code: hit.code, capKw: hit.capKw, adequate: true, fellBack,
           unitsNeeded: 1, proposedKw: hit.capKw };
}

// Trane MTZ package match. On-coil °C (if both present) → °F; else rated indoor
// 80/67°F assumed. Validates required airflow (CFM) against the model rated CFM.
function matchPackageTrane(loadKw, cond, onCoil = null, airflowCfm = null) {
  if (!COND_POINTS[cond]) throw new RangeError(`matchPackageTrane: unknown condition "${cond}"`);
  const reqTC = toMbh(loadKw);
  const amb = COND_POINTS[cond].ambF;
  const hasOC = !!(onCoil && onCoil.db != null && onCoil.wb != null);
  const db = hasOC ? cToF(onCoil.db) : 80;
  const wb = hasOC ? cToF(onCoil.wb) : 67;
  const ranked = rankModels(reqTC, 0, db, wb, amb);
  const best = ranked[0];
  const ratedCfm = best.fan && best.fan.cfm_rated ? best.fan.cfm_rated : null;
  let airflowWarn = null;
  if (airflowCfm != null && ratedCfm) {
    if (Math.abs(airflowCfm - ratedCfm) / ratedCfm > 0.15) {
      airflowWarn = { req: Math.round(airflowCfm), rated: ratedCfm };
    }
  }
  const capKw = best.r.TC / MBH_PER_KW;
  const { qty, totalCapKw } = unitsToMeetLoad(loadKw, capKw);
  return { key: best.key, tons: best.tons, tcMbh: best.r.TC, capKw,
           adequate: !!best.adequate, usedOnCoil: hasOC, ratedCfm, airflowWarn,
           unitsNeeded: qty, proposedKw: totalCapKw,
           // Exact rankModels inputs, so a caller can regenerate this same
           // model's datasheet (generateMtzPdf) without re-deriving them.
           reqTC, db, wb, amb };
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
    ' "qty": <integer, default 1>,',
    ' "condition": <"T1" or "T3" ONLY if the schedule explicitly prints it, else "">,',
    ' "ambientC": <outdoor ambient temperature in °C as a NUMBER if printed (e.g. 46), else "">,',
    ' "onCoilDb": <entering-air dry-bulb to the indoor coil in °C as a NUMBER if printed, else "">,',
    ' "onCoilWb": <entering-air wet-bulb to the indoor coil in °C as a NUMBER if printed, else "">,',
    ' "airflow": <air volume NUMBER if printed (package units), else "">,',
    ' "airflowUnit": <"CFM" or "L/s" exactly as printed, else "">}',
    "Use the SPECIFIED/required capacity, not any competitor 'offered' column.",
    "Only fill condition / ambientC / onCoilDb / onCoilWb / airflow when they are",
    "actually printed on the schedule. NEVER guess or invent them; leave \"\" if absent.",
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
      condition: parseCondition(r.condition, r.ambientC),
      onCoilDb: numOrNull(r.onCoilDb),
      onCoilWb: numOrNull(r.onCoilWb),
      airflow: (() => {
        const a = numOrNull(r.airflow);
        if (a == null) return null;
        return String(r.airflowUnit || "").toLowerCase().includes("l/s") ? lsToCfm(a) : a;
      })(),
    });
  }
  return { rows, skipped };
}

function summarize(rows) {
  const found = rows.map((r) => r.condition).filter((c) => c === "T1" || c === "T3");
  const uniq = [...new Set(found)];
  return {
    count: rows.length,
    hasSplit: rows.some((r) => r.category === "split" || r.category === "ducted"),
    hasPackage: rows.some((r) => r.category === "package"),
    scheduleCondition: uniq.length === 1 ? uniq[0] : null,
  };
}

function capStr(kw) {
  return `${toTr(kw).toFixed(1)} TR (${kw.toFixed(1)} kW)`;
}

// Run every row through its matching engine. choices: { cond, splitBrand,
// pkgVendor, pkgSeries }. Returns { pkgResults, splitResults }, each entry
// either { row, vendor, match } or { row, error } (uncatalogued / no match).
// This is the single source of truth consumed by both buildReply (text) and
// the PDF report generator, so the two stay in sync.
function computeSelections(rows, choices) {
  const { cond, splitBrand, pkgVendor, pkgSeries } = choices;

  const pkgResults = rows
    .filter((r) => r.category === "package")
    .map((r) => {
      if (pkgVendor === "trane") {
        const oc = (r.onCoilDb != null && r.onCoilWb != null)
          ? { db: r.onCoilDb, wb: r.onCoilWb } : null;
        return { row: r, vendor: "trane", match: matchPackageTrane(r.requiredKw, cond, oc, r.airflow) };
      }
      return { row: r, vendor: "skm", match: matchPackageSkm(r.requiredKw, pkgSeries, cond) };
    });

  const BRAND_DISPLAY = { toshiba: "Toshiba", tcl: "TCL", skm: "SKM" };
  const brandTitle = BRAND_DISPLAY[splitBrand] || (String(splitBrand || "").charAt(0).toUpperCase() + String(splitBrand || "").slice(1));
  const splitResults = rows
    .filter((r) => r.category === "split" || r.category === "ducted")
    .map((r) => {
      const famKey = splitFamilyKey(splitBrand, r.category);
      if (!famKey) {
        return { row: r, error: `${brandTitle} ${r.category} not in catalogue — verify` };
      }
      const oc = (splitBrand === "toshiba" && r.onCoilDb != null && r.onCoilWb != null)
        ? { db: r.onCoilDb, wb: r.onCoilWb } : null;
      const m = matchSplit(r.requiredKw, famKey, cond, oc);
      if (!m) return { row: r, error: `${brandTitle} ${r.category} — selection error, verify` };
      return { row: r, match: m };
    });

  return { pkgResults, splitResults };
}

// Build the final WhatsApp reply. choices: { cond, splitBrand, pkgVendor,
// pkgSeries }. skipped is the verify list from normalizeRows.
function buildReply(rows, skipped, choices) {
  const { cond, splitBrand, pkgVendor, pkgSeries } = choices;
  const rowWord = rows.length === 1 ? "row" : "rows";
  const lines = [`📋 *Schedule Selection* — ${rows.length} ${rowWord} · rated at ${cond}`];

  const { pkgResults, splitResults } = computeSelections(rows, choices);

  // Summary accumulators, filled in as each row is rendered below.
  let totalReqKw = 0;
  let totalProposedKw = 0;
  const multiUnitLocations = [];

  if (pkgResults.length) {
    const vendorLabel = pkgVendor === "trane" ? "Trane MTZ"
      : `SKM ${pkgSeries === "apmr-a" ? "APMR-A" : "APMR"}`;
    lines.push("", `🏢 *PACKAGE (${vendorLabel})*`);
    for (const { row: r, vendor, match: m } of pkgResults) {
      totalReqKw += r.requiredKw * r.qty;
      if (vendor === "trane") {
        totalProposedKw += m.proposedKw * r.qty;
        const multi = m.unitsNeeded > 1;
        if (multi) multiUnitLocations.push(r.location);
        const ocTag = m.usedOnCoil
          ? `(on-coil ${r.onCoilDb}/${r.onCoilWb}°C from schedule)` : "(rated indoor 80/67°F)";
        const air = r.airflow != null ? ` · airflow ${Math.round(r.airflow)} CFM` : "";
        const proposedLine = multi
          ? `${m.unitsNeeded}× MTZ ${m.key} (${m.tons} TR each) = ${capStr(m.proposedKw)}`
          : `MTZ ${m.key} · ${m.tons} TR`;
        lines.push(`• ${r.location} — Required: ${capStr(r.requiredKw)} ×${r.qty}${air}`,
          `   → Proposed: ${proposedLine} · ✅ _${ocTag}_${multi ? " · ↪ multiple units in parallel" : ""}`);
        if (m.airflowWarn) {
          lines.push(`   ⚠️ airflow off rated CFM (req ${m.airflowWarn.req} / rated ${m.airflowWarn.rated})`);
        }
      } else {
        totalProposedKw += m.proposedKw * r.qty;
        const multi = m.unitsNeeded > 1;
        if (multi) multiUnitLocations.push(r.location);
        const name = `${m.series === "apmr-a" ? "APMR-A" : "APMR"} ${m.code}`;
        const tags = [];
        if (m.fellBack) tags.push("↪ APMR-A (APMR range exceeded)");
        if (multi) tags.push("↪ multiple units in parallel");
        tags.push("✅");
        const proposedLine = multi
          ? `${m.unitsNeeded}× ${name} (${m.capKw.toFixed(1)} kW each) = ${capStr(m.proposedKw)}`
          : `${name} · ${m.capKw.toFixed(1)} kW`;
        lines.push(`• ${r.location} — Required: ${capStr(r.requiredKw)} ×${r.qty}`,
          `   → Proposed: ${proposedLine} ${cond} · ${tags.join(" · ")}`);
      }
    }
  }

  if (splitResults.length) {
    const BRAND_DISPLAY = { toshiba: "Toshiba", tcl: "TCL", skm: "SKM" };
    const brandTitle = BRAND_DISPLAY[splitBrand] || (splitBrand.charAt(0).toUpperCase() + splitBrand.slice(1));
    lines.push("", `❄️ *SPLIT (${brandTitle})*`);
    for (const { row: r, match: m, error } of splitResults) {
      totalReqKw += r.requiredKw * r.qty;
      if (error) {
        lines.push(`• ${r.location} — Required: ${capStr(r.requiredKw)} ×${r.qty}`,
          `   → ⚠️ ${error}`);
        continue;
      }
      totalProposedKw += m.proposedKw * r.qty;
      const multi = m.unitsNeeded > 1;
      if (multi) multiUnitLocations.push(r.location);
      const kind = r.category === "ducted" ? "ducted" : "hi-wall";
      const ocTag = m.usedOnCoil ? ` · (on-coil ${r.onCoilDb}/${r.onCoilWb}°C from schedule)` : "";
      const proposedLine = multi
        ? `${m.unitsNeeded}× ${m.label} (${m.capKw.toFixed(1)} kW each) = ${capStr(m.proposedKw)}`
        : `${m.label} · ${m.capKw.toFixed(1)} kW`;
      lines.push(`• ${r.location} (${kind}) — Required: ${capStr(r.requiredKw)} ×${r.qty}`,
        `   → Proposed: ${proposedLine} ${cond} · ✅${multi ? " · ↪ multiple units in parallel" : ""}${ocTag}`);
    }
  }

  lines.push("", "📊 *Summary*",
    `• Total rows: ${rows.length} (${splitResults.length} split, ${pkgResults.length} package)`,
    `• Total required: ${capStr(totalReqKw)}`,
    `• Total proposed: ${capStr(totalProposedKw)}`);
  if (multiUnitLocations.length) {
    lines.push(`• Rows needing multiple units in parallel: ${multiUnitLocations.length} (${multiUnitLocations.join(", ")})`);
  }
  if (skipped && skipped.length) {
    lines.push(`• Rows to verify: ${skipped.length}`);
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
  const norm = normalizeRows(parsed);
  return { ...norm, scheduleCondition: summarize(norm.rows).scheduleCondition };
}

module.exports = {
  KW_PER_TR, MBH_PER_KW, COND_POINTS, SPLIT_FAMILY,
  toKw, toTr, toMbh, parseCondition, lsToCfm, cToF, classifyCategory,
  splitFamilyKey, matchSplit, unitsToMeetLoad,
  matchPackageSkm, matchPackageTrane,
  buildExtractionPrompt, normalizeRows,
  summarize, buildReply, computeSelections, rowsFromScheduleImage,
};
