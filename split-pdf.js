// ============================================================
//  split-pdf.js — Split unit selection report PDF generator
//  Input: processed results array from handleSplitStep
// ============================================================
const PDFDocument = require("pdfkit");

const f2  = (x) => x == null || isNaN(x) ? "—" : Number(x).toFixed(2);
const f1  = (x) => x == null || isNaN(x) ? "—" : Number(x).toFixed(1);
const pct = (x) => x == null ? "—" : (x >= 0 ? "+" : "") + (x * 100).toFixed(0) + "%";

/**
 * Generate a split unit selection PDF report.
 *
 * @param {object} opts
 *   brand   – "Toshiba" | "TCL" | "SKM"
 *   project – optional project name string
 *   units   – array of unit result objects:
 *     { lineNum, loadKw, typeStr, famLabel, condStr, idb, iwb, odb, condition,
 *       count, model, tc, shc, p, eer, margin, adequate, splitNote, error }
 *
 * @returns {Buffer} PDF buffer
 */
async function generateSplitPdf({ brand, project, units }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      info: { Title: `${brand} Split Unit Selection Report` },
    });
    doc.on("data", c => chunks.push(c));
    doc.on("end",  () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const PW = doc.page.width;
    const PH = doc.page.height;
    const L  = 40;
    const W  = PW - 80;

    // ── Brand accent colour ────────────────────────────────────
    const ACCENT = brand === "Toshiba" ? "#c8102e"
                 : brand === "TCL"     ? "#e4032e"
                 :                       "#003087"; // SKM blue

    // ── Header bar ────────────────────────────────────────────
    doc.rect(L, 40, W, 60).fill(ACCENT);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7)
       .text(`${brand.toUpperCase()} · SPLIT UNIT SELECTION REPORT`, L + 12, 48, { characterSpacing: 1.2 });
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(26)
       .text("Split Unit Selection", L + 12, 56);

    const dateStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    doc.fillColor("rgba(255,255,255,0.75)").font("Helvetica").fontSize(8)
       .text(`${project ? project + "  ·  " : ""}Generated: ${dateStr}`, L + 12, 88, { width: W - 24 });

    let y = 118;

    // ── Section header helper ──────────────────────────────────
    const section = (title) => {
      doc.rect(L, y, W, 16).fill("#1a1a1a");
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7)
         .text(title.toUpperCase(), L + 6, y + 4, { characterSpacing: 0.8 });
      y += 20;
    };

    // ── Two-column row helper ──────────────────────────────────
    const cw = W / 4;
    const row4 = (l1, v1, l2, v2, l3, v3, l4, v4, shade) => {
      if (shade) doc.rect(L, y, W, 18).fill("#f7f7f7");
      const cols = [[l1,v1],[l2,v2],[l3,v3],[l4,v4]];
      cols.forEach(([lbl, val], i) => {
        const x = L + i * cw;
        doc.fillColor("#888888").font("Helvetica").fontSize(7).text(lbl, x + 5, y + 2, { width: cw - 6 });
        doc.fillColor("#111111").font("Helvetica-Bold").fontSize(9).text(String(val ?? "—"), x + 5, y + 10, { width: cw - 6 });
      });
      doc.rect(L, y, W, 18).stroke("#e0e0e0");
      y += 18;
    };

    const row2 = (l1, v1, l2, v2, shade) => {
      if (shade) doc.rect(L, y, W, 18).fill("#f7f7f7");
      [[l1,v1],[l2,v2]].forEach(([lbl, val], i) => {
        const x = L + i * (W / 2);
        doc.fillColor("#888888").font("Helvetica").fontSize(7).text(lbl, x + 5, y + 2, { width: W/2 - 6 });
        doc.fillColor("#111111").font("Helvetica-Bold").fontSize(9).text(String(val ?? "—"), x + 5, y + 10, { width: W/2 - 6 });
      });
      doc.rect(L, y, W, 18).stroke("#e0e0e0");
      y += 18;
    };

    // ── Summary row helper for the table ──────────────────────
    const tableRow = (cells, widths, isHeader, ok) => {
      const rowH = isHeader ? 18 : 22;
      if (isHeader) {
        doc.rect(L, y, W, rowH).fill("#1a1a1a");
      } else {
        doc.rect(L, y, W, rowH).fill(ok === true ? "#f0fff5" : ok === false ? "#fff8f0" : "#ffffff");
      }
      let x = L;
      cells.forEach((cell, i) => {
        const w = widths[i];
        if (isHeader) {
          doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(6.5)
             .text(cell.toUpperCase(), x + 4, y + 5, { width: w - 6, align: "center", characterSpacing: 0.5 });
        } else {
          const isBold = i === 3; // model column
          doc.fillColor(ok === false ? "#b25e00" : "#111111")
             .font(isBold ? "Helvetica-Bold" : "Helvetica").fontSize(8)
             .text(String(cell ?? "—"), x + 4, y + 6, { width: w - 6, align: i > 2 ? "center" : "left" });
        }
        x += w;
      });
      doc.rect(L, y, W, rowH).stroke("#d0d0d0");
      y += rowH;
    };

    // ── Page overflow guard ────────────────────────────────────
    const checkPage = (needed = 60) => {
      if (y + needed > PH - 50) {
        doc.addPage();
        y = 40;
      }
    };

    // ── Main selection table ───────────────────────────────────
    section("Selection Results");

    const COL_W = [22, 70, 55, 80, 34, 34, 34, 34, 34, 37];
    const COL_H = ["#", "Type", "Required", "Model Selected", "Count", "TC kW", "SC kW", "Power kW", "EER", "Margin"];
    tableRow(COL_H, COL_W, true);

    units.filter(u => !u.error).forEach((u, i) => {
      checkPage(24);
      const countLabel = u.count > 1 ? `${u.count}×` : "1×";
      const tcTotal  = u.count > 1 ? `${f2(u.tc)}×${u.count}` : f2(u.tc);
      const cells = [
        String(u.lineNum),
        u.famLabel ?? u.typeStr,
        `${f2(u.loadKw)} kW`,
        u.count > 1 ? `${u.count}× ${u.model}` : u.model,
        countLabel,
        f2(u.tc),
        u.shc != null ? f2(u.shc) : "N/A",
        f2(u.p),
        f2(u.eer),
        pct(u.margin),
      ];
      tableRow(cells, COL_W, false, u.adequate);
      y += 2;
    });

    // ── Errors / skipped ──────────────────────────────────────
    const errored = units.filter(u => u.error);
    if (errored.length) {
      checkPage(40);
      y += 6;
      doc.fillColor("#b25e00").font("Helvetica-Bold").fontSize(7)
         .text("SKIPPED / UNRESOLVED LINES", L, y);
      y += 12;
      errored.forEach(u => {
        doc.fillColor("#555555").font("Helvetica").fontSize(8)
           .text(`Line ${u.lineNum}: ${u.error}`, L + 4, y);
        y += 12;
      });
    }

    y += 16;

    // ── Per-unit detail cards ──────────────────────────────────
    units.filter(u => !u.error).forEach((u, i) => {
      checkPage(120);

      // Card header
      const cardColor = u.adequate ? "#1f7a4d" : "#b25e00";
      doc.rect(L, y, W, 20).fill(cardColor);
      const unitTitle = u.count > 1
        ? `Unit ${u.lineNum}  ·  ${u.count}× ${u.model}  (${u.count} units required)`
        : `Unit ${u.lineNum}  ·  ${u.model}`;
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10)
         .text(unitTitle, L + 10, y + 5);
      const statusLabel = u.adequate ? "✓  ADEQUATE" : "⚠  UNDERSIZED";
      doc.fillColor("#ffffff").font("Helvetica").fontSize(7)
         .text(statusLabel, L + 10, y + 14, { align: "right", width: W - 20 });
      y += 24;

      // Inputs
      doc.rect(L, y, W / 2 - 2, 14).fill("#f0f4f2");
      doc.fillColor("#555555").font("Helvetica-Bold").fontSize(7)
         .text("INPUTS", L + 5, y + 3, { characterSpacing: 0.6 });
      y += 14;
      row4("Required Load", `${f2(u.loadKw)} kW`, "Type", u.famLabel ?? u.typeStr,
           "On-Coil DB/WB", u.idb != null ? `${u.idb}/${u.iwb}°C` : "—",
           "Ambient", u.odb != null ? `${u.odb}°C` : u.condition, (i % 2 === 0));
      if (u.splitNote) {
        doc.fillColor("#b25e00").font("Helvetica").fontSize(7.5)
           .text(`⚠ ${u.splitNote}`, L + 5, y + 2);
        y += 13;
      }

      // Outputs
      doc.rect(L, y, W / 2 - 2, 14).fill("#f0f4f2");
      doc.fillColor("#555555").font("Helvetica-Bold").fontSize(7)
         .text("OUTPUTS  (per unit)", L + 5, y + 3, { characterSpacing: 0.6 });
      y += 14;
      row4("Total Cooling (TC)", `${f2(u.tc)} kW`,
           "Sensible (SC)", u.shc != null ? `${f2(u.shc)} kW` : "N/A",
           "Power Input", `${f2(u.p)} kW`,
           "EER", f2(u.eer), (i % 2 === 0));
      row4("Margin", pct(u.margin),
           "Condition", u.condStr ?? u.condition,
           u.count > 1 ? "Combined TC" : "", u.count > 1 ? `${f2(u.tc * u.count)} kW` : "",
           u.count > 1 ? "Combined Power" : "", u.count > 1 ? `${f2(u.p * u.count)} kW` : "", !(i % 2 === 0));

      y += 10;
    });

    // ── Footer ────────────────────────────────────────────────
    checkPage(30);
    y += 8;
    doc.rect(L, y, W, 1).fill("#cccccc");
    y += 6;
    doc.fillColor("#888888").font("Helvetica").fontSize(7)
       .text(
         `${brand} Split Unit Selection Report  ·  Capacities interpolated from published manufacturer data.  ` +
         `Values outside the catalogue grid are edge-clamped and flagged.  ` +
         `Verify against manufacturer selection software before submittal.`,
         L, y, { width: W, lineGap: 1 }
       );

    doc.end();
  });
}

module.exports = { generateSplitPdf };
