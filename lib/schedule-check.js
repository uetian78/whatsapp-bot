// ============================================================
//  The "check the schedule" table: what a person sees of the rows read from a
//  schedule photo, and the corrections they send back. Pure functions, no state.
//
//  Only INPUTS are editable here: tag, type, load, unit and quantity. The kW the
//  engines select from (requiredKw) is always worked out again from the load and
//  unit by schedule-select's own toKw; nothing the client sends can set it.
//  The edits come from a browser, so every field is checked.
//
//  Row ids: "r<n>" is the n-th row read, "s<n>" the n-th row that could not be
//  read (counting from 0, in the order the server holds them).
// ============================================================
const { classifyCategory, normalizeRows, toKw } = require("../schedule-select.js");
const { capacityToKw } = require("../vrf/vrfIntake.js");

const CATEGORIES = ["split", "ducted", "package"];
const CATEGORY_LABEL = { split: "Split", ducted: "Ducted", package: "Package" };

// The units the converter (toKw) knows, as the table shows them.
const UNITS = ["kW", "TR", "MBH", "BTU/h", "kcal/h"];
const UNIT_ALIASES = {
  kw: "kW", tr: "TR", ton: "TR", tons: "TR", mbh: "MBH",
  "btu/h": "BTU/h", "btu/hr": "BTU/h", btuh: "BTU/h", "kcal/h": "kcal/h", "kcal/hr": "kcal/h",
};

const MAX_TAG = 80;
const MAX_QTY = 999;
const MAX_VALUE = 10000000;
const MAX_KW = 50000;
const MAX_EDITS = 300;
const MAX_RAW = 200;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

// Unit typed by the person -> one of UNITS, or null.
function canonicalUnit(u) {
  if (typeof u !== "string") return null;
  return UNIT_ALIASES[u.trim().toLowerCase()] || null;
}

// How toKw reads a stored unit: nothing printed means kW, and the table says so.
function unitLabel(srcUnit) {
  return capacityToKw(1, srcUnit || "").unit;
}

// A load: a finite number above zero, no more than MAX_VALUE. Numbers or numeric text.
function parseValue(v) {
  let n = null;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^\s*[+]?(\d+\.?\d*|\.\d+)\s*$/.test(v)) n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= MAX_VALUE ? n : null;
}

function parseQty(v) {
  let n = null;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_QTY ? n : null;
}

// Accepts the category itself or anything the schedule classifier maps to one.
function parseType(v) {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  if (CATEGORIES.includes(t)) return t;
  return classifyCategory(t);
}

const rowName = (name, n, what) => (name && String(name).trim() ? String(name).trim().slice(0, 40) : `${what} ${n}`);

// Edits -> { rows, skipped, errors, errorIds }. With any error the original rows
// and skipped come back unchanged. Rows with no change are the same objects.
function applyRowEdits(rows, skipped, edits) {
  const original = (errors, errorIds) => ({ rows, skipped, errors, errorIds });
  const list = isObject(edits) && Array.isArray(edits.rows) ? edits.rows : edits;
  if (!Array.isArray(list)) return original(["I couldn't read the table. Please try again."], []);
  if (list.length > MAX_EDITS) return original(["That table is too long to check."], []);

  const errors = [];
  const errorIds = [];
  const fail = (id, who, why) => { errors.push(`${who}: ${why}`); errorIds.push(id); };

  const nextRows = rows.slice();
  const stillSkipped = [];
  const fixed = [];
  const byId = new Map();
  for (const e of list) {
    if (!isObject(e) || typeof e.id !== "string") return original(["I couldn't read the table. Please try again."], []);
    if (byId.has(e.id)) return original(["That table has the same row twice. Please reload it."], []);
    byId.set(e.id, e);
  }
  const known = new Set([...rows.map((_, i) => `r${i}`), ...skipped.map((_, i) => `s${i}`)]);
  for (const id of byId.keys()) {
    if (!known.has(id)) return original(["That table is out of date. Please use the newest one."], []);
  }

  rows.forEach((row, i) => {
    const id = `r${i}`;
    const e = byId.get(id);
    if (!e) return;
    const who = rowName(row.location, i + 1, "Row");
    const next = { ...row };
    let changed = false;
    let ok = true;
    const bad = (why) => { fail(id, who, why); ok = false; };

    if (e.tag !== undefined) {
      if (typeof e.tag !== "string") bad("the tag must be text");
      else if (e.tag.trim() !== row.location) {
        if (e.tag.trim().length > MAX_TAG) bad(`the tag is longer than ${MAX_TAG} characters`);
        else { next.location = e.tag.trim(); changed = true; }
      }
    }
    if (e.type !== undefined) {
      const cat = parseType(e.type);
      if (!cat) bad("pick Split, Ducted or Package");
      else if (cat !== row.category) { next.category = cat; next.type = CATEGORY_LABEL[cat]; changed = true; }
    }
    if (e.qty !== undefined) {
      const q = parseQty(e.qty);
      if (q === null) bad(`quantity must be a whole number from 1 to ${MAX_QTY}`);
      else if (q !== row.qty) { next.qty = q; changed = true; }
    }

    // Load and unit: a change to either works requiredKw out again, with toKw.
    let value = row.srcValue;
    let unit = unitLabel(row.srcUnit);
    let capChanged = false;
    if (e.value !== undefined) {
      const v = parseValue(e.value);
      if (v === null) bad(`the load must be a number above 0 (up to ${MAX_VALUE})`);
      else if (v !== row.srcValue) { value = v; capChanged = true; }
    }
    if (e.unit !== undefined) {
      const u = canonicalUnit(e.unit);
      if (!u) bad(`the unit must be one of ${UNITS.join(", ")}`);
      else if (u !== unit) { unit = u; capChanged = true; }
    }
    if (ok && capChanged) {
      const kw = toKw(value, unit);
      if (!Number.isFinite(kw) || kw <= 0 || kw > MAX_KW) bad("that load is not a sensible capacity");
      else { next.srcValue = value; next.srcUnit = unit; next.requiredKw = kw; changed = true; }
    }
    if (ok && changed) nextRows[i] = next;
  });

  skipped.forEach((row, i) => {
    const id = `s${i}`;
    const e = byId.get(id);
    const who = rowName(row.location, i + 1, "Unread row");
    if (!e) { stillSkipped.push(row); return; }

    const touched = !isBlank(e.type) || !isBlank(e.value) || !isBlank(e.unit);
    const tag = typeof e.tag === "string" && e.tag.trim() ? e.tag.trim() : row.location;
    if (!touched) { stillSkipped.push(row); return; }
    const cat = parseType(e.type);
    const value = parseValue(e.value);
    const unit = canonicalUnit(e.unit);
    const qty = isBlank(e.qty) ? 1 : parseQty(e.qty);
    if (String(tag).length > MAX_TAG) return fail(id, who, `the tag is longer than ${MAX_TAG} characters`);
    if (!cat) return fail(id, who, "pick Split, Ducted or Package");
    if (value === null) return fail(id, who, `the load must be a number above 0 (up to ${MAX_VALUE})`);
    if (!unit) return fail(id, who, `pick the unit: ${UNITS.join(", ")}`);
    if (qty === null) return fail(id, who, `quantity must be a whole number from 1 to ${MAX_QTY}`);
    // The same reading every row gets: normalizeRows classifies and converts.
    const made = normalizeRows([{ location: tag, type: CATEGORY_LABEL[cat], category: cat, capacity: value, unit, qty }]).rows[0];
    if (!made || !Number.isFinite(made.requiredKw) || made.requiredKw <= 0 || made.requiredKw > MAX_KW) {
      return fail(id, who, "that load is not a sensible capacity");
    }
    fixed.push(made);
  });

  if (errors.length) return original(errors, errorIds);
  return { rows: [...nextRows, ...fixed], skipped: stillSkipped, errors: [], errorIds: [] };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What the screen is given: display values only. opts: { draft, errorIds, errors }.
// A draft (the edits as typed) is shown in place of the values, so a rejected
// table comes back with the person's typing still in it.
function rowCheckView(rows, skipped, opts = {}) {
  const draft = new Map();
  for (const e of Array.isArray(opts.draft) ? opts.draft : []) if (isObject(e) && typeof e.id === "string") draft.set(e.id, e);
  const badIds = new Set(opts.errorIds || []);
  const shown = (v, fallback) => (v === undefined ? fallback : typeof v === "number" || typeof v === "string" ? v : "");
  const clip = (v, max) => (typeof v === "string" ? v.slice(0, max) : v);

  const outRows = rows.map((r, i) => {
    const id = `r${i}`;
    const d = draft.get(id) || {};
    const o = {
      id,
      tag: clip(shown(d.tag, r.location), MAX_RAW),
      type: clip(shown(d.type, r.category), 40),
      value: clip(shown(d.value, r.srcValue), 40),
      unit: clip(shown(d.unit, unitLabel(r.srcUnit)), 20),
      qty: clip(shown(d.qty, r.qty), 20),
    };
    if (badIds.has(id)) o.bad = true;
    return o;
  });
  const outSkipped = skipped.map((s, i) => {
    const id = `s${i}`;
    const d = draft.get(id);
    const o = { id, tag: clip(shown(d && d.tag, s.location), MAX_RAW), raw: String(s.raw == null ? "" : s.raw).slice(0, MAX_RAW) };
    if (d) {
      o.type = clip(shown(d.type, ""), 40);
      o.value = clip(shown(d.value, ""), 40);
      o.unit = clip(shown(d.unit, ""), 20);
      o.qty = clip(shown(d.qty, ""), 20);
    }
    if (badIds.has(id)) o.bad = true;
    return o;
  });

  const head = `I read *${plural(rows.length, "row", "rows")}*. Check them against your schedule, fix anything that is wrong, then tap *Looks right*.`;
  const note = skipped.length
    ? `\n\n${plural(skipped.length, "row", "rows")} I couldn't read ${skipped.length === 1 ? "is" : "are"} marked below. Fill in the type, load and unit to include ${skipped.length === 1 ? "it" : "them"}, or leave ${skipped.length === 1 ? "it" : "them"} blank to skip.`
    : "";
  const view = { text: head + note, rows: outRows, skipped: outSkipped };
  if (opts.errors && opts.errors.length) view.errors = opts.errors.slice(0, 20).map((s) => String(s).slice(0, 300));
  return view;
}

module.exports = { applyRowEdits, rowCheckView, canonicalUnit, unitLabel, UNITS, CATEGORIES, CATEGORY_LABEL, MAX_EDITS };
