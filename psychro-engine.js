// ============================================================
//  psychro-engine.js — Psychrometric Analysis Engine
//  Imperial units: °F, CFM, MBtu/h (MBH), lb/lb
// ============================================================

const P_ATM = 14.696; // psia at sea level

// ── Saturation pressure (psia) ───────────────────────────────
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

// ── Humidity ratio (lb/lb) from DB / WB ─────────────────────
function wFromDbWb(Tdb, Twb) {
  const pwsWb = pWs(Twb);
  const Ws = 0.621945 * pwsWb / (P_ATM - pwsWb);
  const W  = ((1093 - 0.556*Twb)*Ws - 0.240*(Tdb - Twb)) / (1093 + 0.444*Tdb - Twb);
  return Math.max(W, 0);
}

// ── Enthalpy (Btu/lb dry air) ────────────────────────────────
function enthalpy(Tdb, W) {
  return 0.240*Tdb + W*(1061 + 0.444*Tdb);
}

// ── WB from DB + enthalpy (bisection) ───────────────────────
function wbFromDbH(Tdb, h) {
  let lo = -20, hi = Tdb;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    enthalpy(Tdb, wFromDbWb(Tdb, mid)) < h ? lo = mid : hi = mid;
  }
  return (lo + hi) / 2;
}

// ── Dew point from W (bisection on pWs) ─────────────────────
function dewPoint(W) {
  const pw = W * P_ATM / (0.621945 + W);
  let lo = -60, hi = 200;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    pWs(mid) < pw ? lo = mid : hi = mid;
  }
  return (lo + hi) / 2;
}

// ── Relative humidity (%) ────────────────────────────────────
function rh(Tdb, W) {
  const pw = W * P_ATM / (0.621945 + W);
  return Math.min((pw / pWs(Tdb)) * 100, 100);
}

// ── Convert °C to °F ─────────────────────────────────────────
const c2f = c => c * 9/5 + 32;
const f2c = f => (f - 32) * 5/9;

// ── Apparatus Dew Point (ADP) ────────────────────────────────
// Extend the straight line from on-coil to off-coil on the
// psychrometric chart until it hits the saturation curve.
function calcADP(db1, W1, db2, W2) {
  // Line: W = W1 + (W2-W1)/(db2-db1) * (db - db1)
  // Saturation: W_sat(db) solved numerically
  if (Math.abs(db2 - db1) < 0.01) return null;
  const slope = (W2 - W1) / (db2 - db1);
  let lo = -10, hi = Math.min(db1, db2);
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const wLine = W1 + slope * (mid - db1);
    const wSat  = wFromDbWb(mid, mid); // saturation W at that temp
    wLine > wSat ? lo = mid : hi = mid;
  }
  return (lo + hi) / 2;
}

// ── Full psychrometric analysis ──────────────────────────────
/**
 * @param {object} p
 *   db1, wb1  – on-coil DB / WB (°F)
 *   db2, wb2  – off-coil DB / WB (°F)
 *   cfm       – airflow (CFM)
 *   tcGiven   – optional: given total capacity (MBH)
 *   scGiven   – optional: given sensible capacity (MBH)
 */
function analyze({ db1, wb1, db2, wb2, cfm, tcGiven, scGiven }) {
  // On-coil state
  const W1 = wFromDbWb(db1, wb1);
  const h1 = enthalpy(db1, W1);
  const dp1 = dewPoint(W1);
  const rh1 = rh(db1, W1);

  // Off-coil state
  const W2 = wFromDbWb(db2, wb2);
  const h2 = enthalpy(db2, W2);
  const dp2 = dewPoint(W2);
  const rh2 = rh(db2, W2);

  // Capacities
  const tc   = 4.5   * cfm * (h1 - h2);   // MBH
  const sc   = 1.08  * cfm * (db1 - db2);  // MBH
  const lat  = tc - sc;
  const shr  = sc / tc;

  // Moisture
  const dW         = W1 - W2;
  const moisture_lb = dW * 4.5 * cfm / 1000; // lb/h (4.5*cfm = lb-dry-air/h at std density)
  const moisture_pt = moisture_lb * 2;         // pints/h (1 lb water ≈ 2 pints)

  // ADP & bypass factor
  const adp = calcADP(db1, W1, db2, W2);
  const bf  = adp != null && (db1 - adp) > 0.1
    ? (db2 - adp) / (db1 - adp)
    : null;

  // Verification
  let tcErr = null, scErr = null;
  if (tcGiven != null) tcErr = ((tc - tcGiven) / tcGiven) * 100;
  if (scGiven != null) scErr = ((sc - scGiven) / scGiven) * 100;

  return {
    // On-coil
    db1, wb1, W1, h1, dp1, rh1,
    // Off-coil
    db2, wb2, W2, h2, dp2, rh2,
    // Deltas
    dDB: db1 - db2, dWB: wb1 - wb2, dH: h1 - h2, dW,
    // Capacities (MBH)
    tc, sc, lat, shr,
    // Airflow
    cfm,
    // Moisture
    moisture_lb, moisture_pt,
    // ADP / BF
    adp, bf,
    // Verification
    tcGiven, scGiven, tcErr, scErr,
  };
}

// ── Format full analysis as WhatsApp text ────────────────────
function formatAnalysis(r) {
  const f = (x, p = 1) => x == null || isNaN(x) ? "—" : x.toFixed(p);
  const pct = x => x == null ? "—" : (x >= 0 ? "+" : "") + x.toFixed(1) + "%";

  let msg = `*🌡️ Psychrometric Analysis*\n`;
  msg += `_Conditions at sea level · Imperial units_\n`;
  msg += `${"─".repeat(30)}\n\n`;

  msg += `*ON-COIL STATE*\n`;
  msg += `• DB / WB : ${f(r.db1)}°F / ${f(r.wb1)}°F\n`;
  msg += `• Humidity Ratio (W₁) : ${(r.W1 * 7000).toFixed(1)} gr/lb  (${r.W1.toFixed(4)} lb/lb)\n`;
  msg += `• Enthalpy (h₁) : ${f(r.h1, 2)} Btu/lb\n`;
  msg += `• Dew Point : ${f(r.dp1)}°F  (${f(f2c(r.dp1))}°C)\n`;
  msg += `• Relative Humidity : ${f(r.rh1, 0)}%\n\n`;

  msg += `*OFF-COIL STATE*\n`;
  msg += `• DB / WB : ${f(r.db2)}°F / ${f(r.wb2)}°F\n`;
  msg += `• Humidity Ratio (W₂) : ${(r.W2 * 7000).toFixed(1)} gr/lb  (${r.W2.toFixed(4)} lb/lb)\n`;
  msg += `• Enthalpy (h₂) : ${f(r.h2, 2)} Btu/lb\n`;
  msg += `• Dew Point : ${f(r.dp2)}°F  (${f(f2c(r.dp2))}°C)\n`;
  msg += `• Relative Humidity : ${f(r.rh2, 0)}%\n\n`;

  msg += `*PROCESS (Δ On→Off)*\n`;
  msg += `• ΔDB : ${f(r.dDB)}°F   ΔWB : ${f(r.dWB)}°F\n`;
  msg += `• Δh  : ${f(r.dH, 2)} Btu/lb\n`;
  msg += `• ΔW  : ${(r.dW * 7000).toFixed(1)} gr/lb\n\n`;

  msg += `*CAPACITY  (airflow: ${r.cfm.toLocaleString()} CFM)*\n`;
  msg += `• Total Cooling  : ${f(r.tc, 1)} MBH  (${f(r.tc / 12, 2)} TR  |  ${f(r.tc * 0.293, 1)} kW)\n`;
  msg += `• Sensible       : ${f(r.sc, 1)} MBH  (${f(r.sc / 12, 2)} TR)\n`;
  msg += `• Latent         : ${f(r.lat, 1)} MBH  (${f(r.lat / 12, 2)} TR)\n`;
  msg += `• SHR            : ${r.shr.toFixed(3)}\n\n`;

  msg += `*MOISTURE REMOVAL*\n`;
  msg += `• ${f(r.moisture_lb, 1)} lb/h  (${f(r.moisture_pt, 1)} pints/h)\n\n`;

  msg += `*COIL CHARACTERISTICS*\n`;
  if (r.adp != null) {
    msg += `• ADP (App. Dew Point) : ${f(r.adp)}°F  (${f(f2c(r.adp))}°C)\n`;
  }
  if (r.bf != null) {
    msg += `• Bypass Factor : ${r.bf.toFixed(3)}\n`;
    msg += `• Contact Factor : ${(1 - r.bf).toFixed(3)}\n`;
  }

  // Verification
  if (r.tcGiven != null || r.scGiven != null) {
    msg += `\n*VERIFICATION vs. GIVEN*\n`;
    if (r.tcGiven != null) {
      msg += `• Total: calc ${f(r.tc, 1)} vs given ${f(r.tcGiven, 1)} MBH → ${pct(r.tcErr)}\n`;
    }
    if (r.scGiven != null) {
      msg += `• Sensible: calc ${f(r.sc, 1)} vs given ${f(r.scGiven, 1)} MBH → ${pct(r.scErr)}\n`;
    }
  }

  msg += `\n_All values at standard sea-level pressure (14.696 psia)._`;
  return msg;
}

module.exports = { analyze, formatAnalysis, c2f, f2c, wFromDbWb, enthalpy, dewPoint, rh };
