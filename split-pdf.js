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

    // ── Palette (matches HTML --ink / --mut / --ok / --warn) ──
    const INK    = "#10171d";   // dark navy — all headers
    const MUT    = "#69767e";   // muted grey for labels
    const OK     = "#1f7a4d";   // adequate status
    const WARN   = "#b25e00";   // undersized status
    const BORDER = "#d0d0d0";

    // ── Header bar (dark ink, no brand accent) ─────────────────
    doc.rect(L, 40, W, 60).fill(INK);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7)
       .text(`${brand.toUpperCase()} · SPLIT UNIT SELECTION REPORT`, L + 12, 48, { characterSpacing: 1.2 });
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(26)
       .text("Split Unit Selection", L + 12, 56);

    const dateStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    doc.fillColor("rgba(255,255,255,0.65)").font("Helvetica").fontSize(8)
       .text(`${project ? project + "  ·  " : ""}Generated: ${dateStr}`, L + 12, 88, { width: W - 24 });

    let y = 118;

    // ── Section header helper (dark, no accent) ────────────────
    const section = (title) => {
      doc.rect(L, y, W, 16).fill(INK);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7)
         .text(title.toUpperCase(), L + 6, y + 4, { characterSpacing: 0.8 });
      y += 20;
    };

    // ── Two-column row helpers ─────────────────────────────────
    const cw = W / 4;
    const row4 = (l1, v1, l2, v2, l3, v3, l4, v4, shade) => {
      if (shade) doc.rect(L, y, W, 18).fill("#f7f7f7");
      const cols = [[l1,v1],[l2,v2],[l3,v3],[l4,v4]];
      cols.forEach(([lbl, val], i) => {
        const x = L + i * cw;
        doc.fillColor(MUT).font("Helvetica").fontSize(7).text(lbl, x + 5, y + 2, { width: cw - 6 });
        doc.fillColor("#111111").font("Helvetica-Bold").fontSize(9).text(String(val ?? "—"), x + 5, y + 10, { width: cw - 6 });
      });
      doc.rect(L, y, W, 18).stroke(BORDER);
      y += 18;
    };

    // ── Summary table row helper ───────────────────────────────
    const tableRow = (cells, widths, kind, ok) => {
      // kind: "header" | "data" | "total"
      const rowH = kind === "header" ? 18 : 22;
      if (kind === "header") {
        doc.rect(L, y, W, rowH).fill(INK);
      } else if (kind === "total") {
        doc.rect(L, y, W, rowH).fill(INK);
      } else {
        doc.rect(L, y, W, rowH).fill(ok === true ? "#f0fff5" : ok === false ? "#fff8f0" : "#ffffff");
      }
      let x = L;
      cells.forEach((cell, i) => {
        const w = widths[i];
        if (kind === "header") {
          doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(6.5)
             .text(cell.toUpperCase(), x + 4, y + 5, { width: w - 6, align: "center", characterSpacing: 0.5 });
        } else if (kind === "total") {
          doc.fillColor(cell ? "#ffffff" : "rgba(255,255,255,0.35)")
             .font("Helvetica-Bold").fontSize(8)
             .text(String(cell ?? ""), x + 4, y + 6, { width: w - 6, align: i > 2 ? "center" : "left" });
        } else {
          doc.fillColor(ok === false ? WARN : "#111111")
             .font(i === 3 ? "Helvetica-Bold" : "Helvetica").fontSize(8)
             .text(String(cell ?? "—"), x + 4, y + 6, { width: w - 6, align: i > 2 ? "center" : "left" });
        }
        x += w;
      });
      doc.rect(L, y, W, rowH).stroke(BORDER);
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
    tableRow(COL_H, COL_W, "header");

    const goodUnits = units.filter(u => !u.error);
    goodUnits.forEach((u) => {
      checkPage(24);
      const countLabel = u.count > 1 ? `${u.count}×` : "1×";
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
      tableRow(cells, COL_W, "data", u.adequate);
      y += 2;
    });

    // ── Totals row ─────────────────────────────────────────────
    if (goodUnits.length) {
      checkPage(24);
      const tQty  = goodUnits.reduce((s, u) => s + (u.count || 1), 0);
      const tTC   = goodUnits.reduce((s, u) => s + (u.tc  || 0) * (u.count || 1), 0);
      const tSC   = goodUnits.every(u => u.shc != null)
                  ? goodUnits.reduce((s, u) => s + (u.shc || 0) * (u.count || 1), 0)
                  : null;
      const tP    = goodUnits.reduce((s, u) => s + (u.p   || 0) * (u.count || 1), 0);
      const totCells = [
        "TOTAL", "", "", `${goodUnits.length} line(s)`,
        `${tQty}×`,
        f2(tTC),
        tSC != null ? f2(tSC) : "—",
        f2(tP),
        "", "",
      ];
      tableRow(totCells, COL_W, "total");
    }

    // ── Errors / skipped ──────────────────────────────────────
    const errored = units.filter(u => u.error);
    if (errored.length) {
      checkPage(40);
      y += 6;
      doc.fillColor(WARN).font("Helvetica-Bold").fontSize(7)
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
    goodUnits.forEach((u, i) => {
      checkPage(120);

      // Card header — always dark ink; status as text pill on the right
      doc.rect(L, y, W, 20).fill(INK);
      const unitTitle = u.count > 1
        ? `Unit ${u.lineNum}  ·  ${u.count}× ${u.model}  (${u.count} units)`
        : `Unit ${u.lineNum}  ·  ${u.model}`;
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10)
         .text(unitTitle, L + 10, y + 5, { width: W - 110 });

      // Status pill on the right
      const statusLabel = u.adequate ? "ADEQUATE" : "UNDERSIZED";
      const pillColor   = u.adequate ? OK : WARN;
      const pillW = 70, pillH = 14, pillX = L + W - pillW - 6, pillY = y + 3;
      doc.rect(pillX, pillY, pillW, pillH).fill(pillColor);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7)
         .text(statusLabel, pillX, pillY + 3, { width: pillW, align: "center" });
      y += 24;

      // Inputs block
      doc.rect(L, y, W / 2 - 2, 14).fill("#f0f4f2");
      doc.fillColor("#555555").font("Helvetica-Bold").fontSize(7)
         .text("INPUTS", L + 5, y + 3, { characterSpacing: 0.6 });
      y += 14;
      row4("Required Load", `${f2(u.loadKw)} kW`, "Type", u.famLabel ?? u.typeStr,
           "On-Coil DB/WB", u.idb != null ? `${u.idb}/${u.iwb}°C` : "—",
           "Ambient", u.odb != null ? `${u.odb}°C` : u.condition, (i % 2 === 0));
      if (u.splitNote) {
        doc.fillColor(WARN).font("Helvetica").fontSize(7.5)
           .text(`⚠ ${u.splitNote}`, L + 5, y + 2);
        y += 13;
      }

      // Outputs block
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
    doc.fillColor(MUT).font("Helvetica").fontSize(7)
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
