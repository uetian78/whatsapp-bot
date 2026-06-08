// ============================================================
//  mtz-engine.js  — Trane MTZ computation engine
//  Ported directly from the embedded JS in mtz-selector.html
// ============================================================

const MTZ_DATA = require("./mtz-data.json");

const DB_AX  = MTZ_DATA.db;
const WB_AX  = MTZ_DATA.wb;
const AMB_AX = MTZ_DATA.amb;
const MODELS = Object.keys(MTZ_DATA.models);
const TR_PER_MBH = 1 / 12;
const P_ATM = 14.696; // psia

// ── Psychrometrics ───────────────────────────────────────────
function pWs(T) {
  const TR = T + 459.67;
  let ln;
  if (T < 32) {
    ln = -1.0214165e4/TR - 4.8932428 - 5.3765794e-3*TR + 1.9202377e-7*TR**2
       + 3.5575832e-10*TR**3 - 9.0344688e-14*TR**4 + 4.1635019*Math.log(TR);
  } else {
    ln = -1.0440397e4/TR - 1.1294650e1 - 2.7022355e-2*TR + 1.2890360e-5*TR**2
       - 2.4780681e-9*TR**3 + 6.5459673*Math.log(TR);
  }
  return Math.exp(ln);
}

function wFromDbWb(Tdb, Twb) {
  const pwsWb = pWs(Twb);
  const Ws = 0.621945 * pwsWb / (P_ATM - pwsWb);
  const W = ((1093 - 0.556*Twb)*Ws - 0.240*(Tdb - Twb)) / (1093 + 0.444*Tdb - Twb);
  return Math.max(W, 0);
}

const enthalpy = (Tdb, W) => 0.240*Tdb + W*(1061 + 0.444*Tdb);

function wbFromDbH(Tdb, h) {
  let lo = -20, hi = Tdb;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (enthalpy(Tdb, wFromDbWb(Tdb, mid)) < h) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── Interpolation helpers ────────────────────────────────────
function bracket(axis, x) {
  if (x <= axis[0]) return { i0:0, i1:0, f:0, lo:x<axis[0], hi:false };
  const n = axis.length;
  if (x >= axis[n-1]) return { i0:n-1, i1:n-1, f:0, lo:false, hi:x>axis[n-1] };
  for (let i = 0; i < n-1; i++)
    if (x >= axis[i] && x <= axis[i+1])
      return { i0:i, i1:i+1, f:(x-axis[i])/(axis[i+1]-axis[i]), lo:false, hi:false };
  return { i0:n-1, i1:n-1, f:0, lo:false, hi:false };
}

function bracketExtrap(axis, x) {
  const n = axis.length;
  if (n < 2) return bracket(axis, x);
  if (x < axis[0])   return { i0:0,   i1:1,   f:(x-axis[0])/(axis[1]-axis[0]),         lo:true,  hi:false };
  if (x > axis[n-1]) return { i0:n-2, i1:n-1, f:(x-axis[n-2])/(axis[n-1]-axis[n-2]),   lo:false, hi:true  };
  for (let i = 0; i < n-1; i++)
    if (x >= axis[i] && x <= axis[i+1])
      return { i0:i, i1:i+1, f:(x-axis[i])/(axis[i+1]-axis[i]), lo:false, hi:false };
  return { i0:n-1, i1:n-1, f:0, lo:false, hi:false };
}

function rowSuspect(block) {
  const [tc,,pi] = block;
  for (let i = 0; i < 3; i++) {
    if (tc[i+1] < tc[i]-0.05) return true;
    if (pi[i+1] < pi[i]-0.5)  return true;
  }
  return false;
}

// ── Core interpolation ───────────────────────────────────────
function interpolate(modelKey, airflow, db, wb, amb) {
  const m = MTZ_DATA.models[modelKey], AF = m.airflows;
  const bAf  = bracketExtrap(AF, airflow);
  const bDb  = bracket(DB_AX, db);
  const bWb  = bracket(WB_AX, wb);
  const bAmb = bracket(AMB_AX, amb);
  const warnings = [];
  if (bDb.lo  || bDb.hi)  warnings.push(`Entering DB ${db}°F outside table ${DB_AX[0]}–${DB_AX[DB_AX.length-1]}; clamped.`);
  if (bWb.lo  || bWb.hi)  warnings.push(`Entering WB ${wb}°F outside table ${WB_AX[0]}–${WB_AX[WB_AX.length-1]}; clamped.`);
  if (bAmb.lo || bAmb.hi) warnings.push(`Ambient ${amb}°F outside table ${AMB_AX[0]}–${AMB_AX[AMB_AX.length-1]}; clamped.`);
  if (bAf.lo  || bAf.hi)  warnings.push(`Airflow ${airflow} CFM outside band ${AF[0]}–${AF[AF.length-1]}; extrapolated.`);

  const cell = (afi, ambi, wbi, dbi, met) =>
    m.grid[`${AMB_AX[ambi]}_${WB_AX[wbi]}`][afi][met][dbi];

  let suspect = false;
  const interp = (met) => {
    let acc = 0;
    for (const [afi, afw] of [[bAf.i0, 1-bAf.f], [bAf.i1, bAf.f]]) {
      if (afw === 0 && bAf.i0 !== bAf.i1) continue;
      for (const [ambi, ambw] of [[bAmb.i0, 1-bAmb.f], [bAmb.i1, bAmb.f]]) {
        if (ambw === 0 && bAmb.i0 !== bAmb.i1) continue;
        for (const [wbi, wbw] of [[bWb.i0, 1-bWb.f], [bWb.i1, bWb.f]]) {
          if (wbw === 0 && bWb.i0 !== bWb.i1) continue;
          if (rowSuspect(m.grid[`${AMB_AX[ambi]}_${WB_AX[wbi]}`][afi])) suspect = true;
          for (const [dbi, dbw] of [[bDb.i0, 1-bDb.f], [bDb.i1, bDb.f]]) {
            if (dbw === 0 && bDb.i0 !== bDb.i1) continue;
            acc += afw * ambw * wbw * dbw * cell(afi, ambi, wbi, dbi, met);
          }
        }
      }
    }
    return acc;
  };

  let TC = interp(0), SC = interp(1);
  const PI = interp(2);
  let scClamped = false;
  if (SC > TC) { SC = TC; scClamped = true; }
  if (suspect)    warnings.push("Draws on catalogue cells that may have OCR artifacts. Verify before quoting.");
  if (scClamped)  warnings.push("Interpolated sensible exceeded total; clamped SC = TC.");
  return { TC, SC, PI, warnings };
}

// ── Off-coil psychrometrics ──────────────────────────────────
function offCoil(dbOn, wbOn, cfm, TC, SC) {
  const Won  = wFromDbWb(dbOn, wbOn);
  const hOn  = enthalpy(dbOn, Won);
  const dbOff = dbOn - (SC * 1000) / (1.08 * cfm);
  const hOff  = hOn  - (TC * 1000) / (4.5  * cfm);
  let wbOff = wbFromDbH(dbOff, hOff);
  if (wbOff > dbOff) wbOff = dbOff;
  return { dbOff, wbOff, hOn, hOff, Won, Woff: wFromDbWb(dbOff, wbOff) };
}

// ── Fan interpolation ────────────────────────────────────────
function fanEsps(modelKey) {
  return Object.keys(MTZ_DATA.models[modelKey].fan.rows).map(Number).sort((a, b) => a - b);
}

function fanAt(modelKey, esp) {
  const f = MTZ_DATA.models[modelKey].fan;
  const esps = fanEsps(modelKey);
  const b = bracket(esps, esp);
  const r0 = f.rows[esps[b.i0]], r1 = f.rows[esps[b.i1]];
  const mix = (k) => r0[k] * (1 - b.f) + r1[k] * b.f;
  return {
    cfm_min:   Math.round(mix("cfm_min")),
    cfm_max:   Math.round(mix("cfm_max")),
    cfm_rated: Math.round(mix("cfm_rated")),
    rpm:       Math.round(mix("rpm")),
    pw:        Math.round(mix("pw")),
  };
}

function fanRated(modelKey) {
  const m = MTZ_DATA.models[modelKey];
  const f = fanAt(modelKey, m.fan.rated_esp);
  const rows = Object.values(m.fan.rows);
  f.cfm_min = Math.min(...rows.map(r => r.cfm_min));
  f.cfm_max = Math.max(...rows.map(r => r.cfm_max));
  f.cfm_rated = Math.min(Math.max(f.cfm_rated, f.cfm_min), f.cfm_max);
  return f;
}

// ── Auto-select: rank every model ───────────────────────────
function rankModels(reqTC, reqSC, db, wb, amb) {
  return MODELS.map((key) => {
    const fan = fanAt(key, MTZ_DATA.models[key].fan.rated_esp);
    const r   = interpolate(key, fan.cfm_rated, db, wb, amb);
    const oc  = offCoil(db, wb, fan.cfm_rated, r.TC, r.SC);
    const tcMargin = reqTC > 0 ? (r.TC - reqTC) / reqTC : null;
    const scMargin = reqSC > 0 ? (r.SC - reqSC) / reqSC : null;
    const tcOK = reqTC > 0 ? r.TC >= reqTC : true;
    const scOK = reqSC > 0 ? r.SC >= reqSC : true;
    return { key, tons: MTZ_DATA.models[key].tons, fan, r, oc,
             tcMargin, scMargin, tcOK, scOK, adequate: tcOK && scOK, warnings: r.warnings };
  }).sort((a, b) => {
    if (a.adequate !== b.adequate) return a.adequate ? -1 : 1;
    if (a.adequate) return (a.tcMargin ?? 0) - (b.tcMargin ?? 0);
    return (b.tcMargin ?? -1) - (a.tcMargin ?? -1);
  });
}

// ── Full compute for a single model at given conditions ──────
function computeModel(modelKey, db, wb, amb, airflowCfm) {
  const fan = fanRated(modelKey);
  let used = airflowCfm;
  let note = null;
  if (used == null || isNaN(used)) {
    used = fan.cfm_rated; note = `Using rated airflow ${fan.cfm_rated} CFM.`;
  } else if (used < fan.cfm_min) {
    used = fan.cfm_min; note = `Below fan minimum; clamped to ${fan.cfm_min} CFM.`;
  } else if (used > fan.cfm_max) {
    used = fan.cfm_max; note = `Above fan maximum; clamped to ${fan.cfm_max} CFM.`;
  }
  const r  = interpolate(modelKey, used, db, wb, amb);
  const oc = offCoil(db, wb, used, r.TC, r.SC);
  return { ...r, oc, airflow: used, fan, note, db, wb, amb };
}

module.exports = { MTZ_DATA, MODELS, rankModels, computeModel, interpolate, offCoil, fanRated, fanAt };
