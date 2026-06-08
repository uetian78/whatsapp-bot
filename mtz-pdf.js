// ============================================================
//  mtz-pdf.js  —  Trane MTZ selection datasheet PDF generator
//  Uses pdfkit (pure Node.js, no browser required).
// ============================================================
const PDFDocument = require("pdfkit");
const { rankModels, computeModel, MTZ_DATA } = require("./mtz-engine.js");

const fmt = (x, p = 1) =>
  x == null || isNaN(x) ? "—" : x.toLocaleString("en-US", { minimumFractionDigits: p, maximumFractionDigits: p });

/**
 * Generate a Trane MTZ selection datasheet PDF.
 *
 * @param {object} opts
 *   reqTC   – required total cooling in MBtu/h  (e.g. 100)
 *   db      – on-coil dry-bulb  °F
 *   wb      – on-coil wet-bulb  °F
 *   amb     – outdoor ambient   °F
 *   airflow – CFM or null → use rated
 *   project – optional project name
 *   tag     – optional unit tag
 *
 * @returns {Buffer} PDF buffer, or null if no model found.
 */
async function generateMtzPdf({ reqTC, db, wb, amb, airflow, project, tag }) {
  // ── 1. Auto-select best model ──────────────────────────────
  const ranking = rankModels(reqTC, 0, db, wb, amb);
  if (!ranking || !ranking.length) return null;
  const best = ranking[0];
  const modelKey = best.key;
  const m = MTZ_DATA.models[modelKey];
  const g = m.general || null;

  // ── 2. Compute performance at the user's airflow ───────────
  const res = computeModel(modelKey, db, wb, amb, airflow || null);
  const eer   = (res.TC * 1000) / res.PI;
  const trVal = res.TC / 12;
  const shr   = res.SC / res.TC;

  // ── 3. Build PDF ───────────────────────────────────────────
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: `Trane ${modelKey} Selection Datasheet` } });
    doc.on("data", c => chunks.push(c));
    doc.on("end",  () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width - 80; // usable width
    const L = 40; // left margin

    // ── Header bar ──
    doc.rect(L, 40, W, 52).fill("#111111");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8)
       .text("TRANE · MTZ PACKAGE UNIT · TROPICAL APPLICATION", L + 10, 48, { characterSpacing: 1 });
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(30)
       .text(modelKey, L + 10, 56);
    const rightX = L + W - 10;
    doc.fillColor("#cccccc").font("Helvetica").fontSize(9)
       .text(`${m.tons} Ton · Cooling Only`, L + 10, 92, { align: "right", width: W - 20 });
    if (g) {
      doc.fillColor("#aaaaaa").fontSize(8)
         .text(g.full_model, L + 10, 104, { align: "right", width: W - 20 });
    }

    const dateStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    doc.fillColor("#888888").fontSize(8)
       .text(`Generated: ${dateStr}`, L + 10, 116, { align: "right", width: W - 20 });

    let y = 132;

    // ── Section helper ──
    const section = (title) => {
      doc.rect(L, y, W, 16).fill("#111111");
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8)
         .text(title.toUpperCase(), L + 6, y + 4, { characterSpacing: 0.8 });
      y += 20;
    };

    const row2 = (l1, v1, l2, v2) => {
      const cw = W / 2;
      doc.rect(L,         y, cw * 0.38, 18).fill("#f3f5f4").stroke("#cccccc");
      doc.rect(L + cw * 0.38, y, cw * 0.62, 18).fill("#ffffff").stroke("#cccccc");
      doc.rect(L + cw,    y, cw * 0.38, 18).fill("#f3f5f4").stroke("#cccccc");
      doc.rect(L + cw + cw * 0.38, y, cw * 0.62, 18).fill("#ffffff").stroke("#cccccc");
      doc.fillColor("#555555").font("Helvetica-Bold").fontSize(8)
         .text(l1, L + 4, y + 4, { width: cw * 0.38 - 6, lineBreak: false });
      doc.fillColor("#111111").font("Helvetica").fontSize(9)
         .text(v1, L + cw * 0.38 + 4, y + 4, { width: cw * 0.62 - 6, lineBreak: false });
      doc.fillColor("#555555").font("Helvetica-Bold").fontSize(8)
         .text(l2, L + cw + 4, y + 4, { width: cw * 0.38 - 6, lineBreak: false });
      doc.fillColor("#111111").font("Helvetica").fontSize(9)
         .text(v2, L + cw + cw * 0.38 + 4, y + 4, { width: cw * 0.62 - 6, lineBreak: false });
      y += 18;
    };

    const row2b = (l1, v1, l2, v2) => {
      // bold values
      const cw = W / 2;
      doc.rect(L,         y, cw * 0.38, 18).fill("#f3f5f4").stroke("#cccccc");
      doc.rect(L + cw * 0.38, y, cw * 0.62, 18).fill("#ffffff").stroke("#cccccc");
      doc.rect(L + cw,    y, cw * 0.38, 18).fill("#f3f5f4").stroke("#cccccc");
      doc.rect(L + cw + cw * 0.38, y, cw * 0.62, 18).fill("#ffffff").stroke("#cccccc");
      doc.fillColor("#555555").font("Helvetica-Bold").fontSize(8)
         .text(l1, L + 4, y + 4, { width: cw * 0.38 - 6, lineBreak: false });
      doc.fillColor("#111111").font("Helvetica-Bold").fontSize(9)
         .text(v1, L + cw * 0.38 + 4, y + 4, { width: cw * 0.62 - 6, lineBreak: false });
      doc.fillColor("#555555").font("Helvetica-Bold").fontSize(8)
         .text(l2, L + cw + 4, y + 4, { width: cw * 0.38 - 6, lineBreak: false });
      doc.fillColor("#111111").font("Helvetica-Bold").fontSize(9)
         .text(v2, L + cw + cw * 0.38 + 4, y + 4, { width: cw * 0.62 - 6, lineBreak: false });
      y += 18;
    };

    // ── Project / general ──
    section("Project Information");
    row2("Project", project || "—", "Unit Tag", tag || "—");
    row2("Print Date", dateStr, "Drive Type", m.fan.type === "direct" ? "Direct (3-speed)" : "Belt (adjustable pulley)");

    y += 6;

    // ── Selection inputs ──
    section("Selection Inputs");
    row2("Airflow (used)", `${fmt(res.airflow, 0)} CFM`,
         "Fan Airflow Range", `${fmt(res.fan.cfm_min, 0)}–${fmt(res.fan.cfm_max, 0)} CFM`);
    row2("On-coil Dry Bulb", `${fmt(db)}°F`, "On-coil Wet Bulb", `${fmt(wb)}°F`);
    row2("Ambient (outdoor)", `${fmt(amb)}°F`,
         "Fan Speed / Power", `${fmt(res.fan.rpm, 0)} RPM / ${fmt(res.fan.pw / 1000, 2)} kW`);

    y += 6;

    // ── Performance data ──
    section("Performance Data");
    row2b("Total Cooling Capacity", `${fmt(res.TC)} MBtu/h  (${fmt(trVal, 2)} TR)`,
          "Sensible Capacity",      `${fmt(res.SC)} MBtu/h`);
    row2("Airflow Rate",    `${fmt(res.airflow, 0)} CFM`,
         "Power Input",     `${fmt(res.PI / 1000, 2)} kW  (${fmt(res.PI, 0)} W)`);
    row2("Sensible Heat Ratio", shr.toFixed(2),
         "EER",             `${fmt(eer, 2)} Btu/h·W`);
    row2("Off-coil DB / WB", `${fmt(res.oc.dbOff)}°F / ${fmt(res.oc.wbOff)}°F`,
         "Nominal Tons",    `${fmt(trVal, 2)} TR`);

    y += 6;

    // ── Standard unit info ──
    section("Standard Unit Information");
    row2("Model No.",     g ? g.full_model : modelKey,  "Nominal Capacity",   `${m.tons} Ton`);
    row2("Power Supply",  g ? g.power_supply : "380–415V / 3Ph / 50Hz",  "Function", "Cooling Only");
    row2("Net Dimensions (W×D×H)", g ? g.net_dim : "—",  "Air Flow Config.", "Horizontal Flow");
    row2("Net / Gross Weight",
         g ? `${g.net_weight_kg} / ${g.gross_weight_kg} kg` : "—",
         "Max. Current",   g ? `${g.max_current_a} A` : "—");
    row2("Compressor",
         g ? `${g.comp_qty}× ${g.comp_brand} ${g.comp_type}` : "—",
         "Max. Input",     g ? `${g.max_input_kw} kW` : "—");
    row2("Compressor Model", g ? g.comp_model : "—",
         "Outdoor Fan",    g ? g.outdoor_fan : "—");
    row2("Refrigerant / Charge",
         g ? `${g.refrigerant} · ${g.ref_charge}` : "—",
         "Ref. Control",   g ? g.ref_control : "—");

    // ── Catalogue ratings ──
    if (g) {
      y += 6;
      section("Catalogue Ratings (published)");
      // header row
      const cw = W / 4;
      ["Condition", "Total Cooling", "Power Input", "EER"].forEach((h, i) => {
        doc.rect(L + i * cw, y, cw, 18).fill("#e8eeed").stroke("#cccccc");
        doc.fillColor("#333333").font("Helvetica-Bold").fontSize(8)
           .text(h, L + i * cw + 4, y + 4, { width: cw - 8, lineBreak: false });
      });
      y += 18;

      const catRow = (cond, btuh, kw, pi, eer2) => {
        [cond, `${(btuh / 1000).toFixed(1)} MBH · ${kw} kW`, `${pi} kW`, String(eer2)].forEach((v, i) => {
          doc.rect(L + i * cw, y, cw, 18).fill("#ffffff").stroke("#cccccc");
          doc.fillColor("#111111").font("Helvetica").fontSize(8.5)
             .text(v, L + i * cw + 4, y + 4, { width: cw - 8, lineBreak: false });
        });
        y += 18;
      };
      catRow("80/67°F · 95°F amb (T1)",  g.cap1_btuh, g.cap1_kw, g.pi1_kw, g.eer1);
      catRow("80/67°F · 115°F amb (T3)", g.cap2_btuh, g.cap2_kw, g.pi2_kw, g.eer2);

      const cw2 = W / 2;
      ["Rated Indoor Airflow", `${(g.rated_cfm || 0).toLocaleString()} CFM`,
       "Catalogue ESP", `${g.esp_pa} Pa`].forEach((v, i) => {
        const isBold = i % 2 === 0;
        doc.rect(L + Math.floor(i / 2) * (cw2 * 0.5) + (i % 2) * (cw2 * 0.5), y, cw2 * 0.5, 18)
           .fill(isBold ? "#f3f5f4" : "#ffffff").stroke("#cccccc");
        doc.fillColor(isBold ? "#555555" : "#111111")
           .font(isBold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5)
           .text(v, L + Math.floor(i / 2) * (cw2 * 0.5) + (i % 2) * (cw2 * 0.5) + 4, y + 4,
                 { width: cw2 * 0.5 - 8, lineBreak: false });
      });
      y += 18;
    }

    // ── Warnings ──
    if (res.warnings && res.warnings.length) {
      y += 6;
      doc.rect(L, y, W, 14).fill("#fff8ec").stroke("#c98a1a");
      doc.fillColor("#a8730f").font("Helvetica-Bold").fontSize(8)
         .text("FLAGS", L + 6, y + 3, { characterSpacing: 0.5 });
      y += 14;
      res.warnings.forEach(w => {
        doc.rect(L, y, W, 14).fill("#fffcf5").stroke("#c98a1a");
        doc.fillColor("#7a560c").font("Helvetica").fontSize(8)
           .text("· " + w, L + 6, y + 3, { width: W - 12, lineBreak: false });
        y += 14;
      });
    }

    // ── Airflow note ──
    if (res.note) {
      y += 4;
      doc.fillColor("#555577").font("Helvetica-Oblique").fontSize(8)
         .text("ⓘ " + res.note, L, y, { width: W });
      y += 14;
    }

    // ── Footer ──
    y += 10;
    doc.moveTo(L, y).lineTo(L + W, y).strokeColor("#999999").stroke();
    y += 4;
    doc.fillColor("#666666").font("Helvetica").fontSize(8)
       .text(
         "Capacities are gross (no fan-heat deduction) per catalogue note. Performance values are interpolated from catalogue grid points at sea-level psychrometrics and should be confirmed against the manufacturer's selection software prior to submittal. Generated by Trane MTZ Package Unit Selector.",
         L, y, { width: W, lineBreak: true }
       );

    doc.end();
  });
}

module.exports = { generateMtzPdf };
