// ============================================================
//  schedule-pdf.js — Schedule / BOQ selection report PDF generator
//  Input: rows + skipped (from schedule-select.normalizeRows) and the
//  user's choices (cond, splitBrand, pkgVendor, pkgSeries). Reuses
//  schedule-select.computeSelections so the PDF matches the WhatsApp
//  text reply exactly.
// ============================================================
const PDFDocument = require("pdfkit");
const schedule = require("./schedule-select.js");

const { toTr, formatRequiredBlock, formatProposedOnCoil } = schedule;

const f1 = (kw) => (kw == null || isNaN(kw) ? "—" : kw.toFixed(1));
const capCell = (kw) => `${f1(toTr(kw))} TR\n(${f1(kw)} kW)`;

/**
 * Generate a Schedule / BOQ selection PDF report.
 *
 * @param {object} opts
 *   project  – optional project name string
 *   cond     – "T1" | "T3"
 *   splitBrand, pkgVendor, pkgSeries – same choices passed to buildReply
 *   rows     – normalized rows (from schedule-select.normalizeRows)
 *   skipped  – verify list (from schedule-select.normalizeRows)
 *
 * @returns {Buffer} PDF buffer
 */
async function generateSchedulePdf({ project, cond, splitBrand, pkgVendor, pkgSeries, rows, skipped }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      info: { Title: "Schedule / BOQ Selection Report" },
    });
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const PW = doc.page.width;
    const PH = doc.page.height;
    const L = 40;
    const W = PW - 80;

    const INK = "#10171d";
    const MUT = "#69767e";
    const OK = "#1f7a4d";
    const WARN = "#b25e00";
    const BORDER = "#d0d0d0";

    doc.rect(L, 40, W, 60).fill(INK);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7)
       .text("SCHEDULE / BOQ SELECTION REPORT", L + 12, 48, { characterSpacing: 1.2 });
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(26)
       .text("Schedule Selection", L + 12, 56);

    const dateStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    const condLabel = cond === "T1" ? "T1 (35°C)" : "T3 (46°C)";
    doc.fillColor("rgba(255,255,255,0.65)").font("Helvetica").fontSize(8)
       .text(`${project ? project + "  ·  " : ""}Rated at ${condLabel}  ·  Generated: ${dateStr}`, L + 12, 88, { width: W - 24 });

    let y = 118;

    const section = (title) => {
      doc.rect(L, y, W, 16).fill(INK);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7)
         .text(title.toUpperCase(), L + 6, y + 4, { characterSpacing: 0.8 });
      y += 20;
    };

    const checkPage = (needed = 60) => {
      if (y + needed > PH - 50) {
        doc.addPage();
        y = 40;
      }
    };

    // Columns: # | Location | Required | Qty | Proposed Selection | Status
    const COL_W = [22, 110, 95, 30, 175, 83];
    const COL_H = ["#", "Location", "Required", "Qty", "Proposed Selection", "Status"];

    const tableHeader = () => {
      checkPage(20);
      doc.rect(L, y, W, 18).fill(INK);
      let x = L;
      COL_H.forEach((cell, i) => {
        doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(6.5)
           .text(cell.toUpperCase(), x + 4, y + 6, { width: COL_W[i] - 6, characterSpacing: 0.5 });
        x += COL_W[i];
      });
      doc.rect(L, y, W, 18).stroke(BORDER);
      y += 18;
    };

    const tableDataRow = (cells, ok, rowH = 26) => {
      checkPage(rowH + 4);
      doc.rect(L, y, W, rowH).fill(ok === false ? "#fff8f0" : "#f7fbf9");
      let x = L;
      cells.forEach((cell, i) => {
        doc.fillColor(ok === false ? WARN : "#111111")
           .font(i === 4 ? "Helvetica-Bold" : "Helvetica").fontSize(7.5)
           .text(String(cell ?? "—"), x + 4, y + 5, { width: COL_W[i] - 6 });
        x += COL_W[i];
      });
      doc.rect(L, y, W, rowH).stroke(BORDER);
      y += rowH;
    };

    const tableTotalRow = (label, reqKw, propKw) => {
      checkPage(22);
      doc.rect(L, y, W, 20).fill(INK);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8)
         .text(label, L + 4, y + 6, { width: COL_W[0] + COL_W[1] - 8 });
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.5)
         .text(f1(toTr(reqKw)) + " TR", L + COL_W[0] + COL_W[1] + 4, y + 6, { width: COL_W[2] - 8 });
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.5)
         .text(f1(toTr(propKw)) + " TR", L + COL_W[0] + COL_W[1] + COL_W[2] + COL_W[3] + 4, y + 6,
               { width: COL_W[4] - 8 });
      doc.rect(L, y, W, 20).stroke(BORDER);
      y += 20;
    };

    const { pkgResults, splitResults } = schedule.computeSelections(rows, { cond, splitBrand, pkgVendor, pkgSeries });

    let totalReqKw = 0;
    let totalProposedKw = 0;
    let rowNum = 0;
    const multiUnitLocations = [];

    if (pkgResults.length) {
      const vendorLabel = pkgVendor === "trane" ? "Trane MTZ"
        : `SKM ${pkgSeries === "apmr-a" ? "APMR-A" : "APMR"}`;
      section(`Package (${vendorLabel})`);
      tableHeader();
      let pkgReqKw = 0, pkgPropKw = 0;
      for (const { row: r, vendor, match: m } of pkgResults) {
        pkgReqKw += r.requiredKw * r.qty;
        pkgPropKw += m.proposedKw * r.qty;
        totalReqKw += r.requiredKw * r.qty;
        totalProposedKw += m.proposedKw * r.qty;
        const multi = m.unitsNeeded > 1;
        if (multi) multiUnitLocations.push(r.location);
        const req = formatRequiredBlock(r);
        const requiredCell = `${capCell(r.requiredKw)}\n${req.condTxt}\nOn-coil: ${req.onCoilTxt}`;
        const proposedModel = vendor === "trane"
          ? (multi ? `${m.unitsNeeded}× MTZ ${m.key} (${m.tons} TR each)` : `MTZ ${m.key} · ${m.tons} TR`)
          : (() => {
              const name = `${m.series === "apmr-a" ? "APMR-A" : "APMR"} ${m.code}`;
              return multi ? `${m.unitsNeeded}× ${name} (${m.capKw.toFixed(1)} kW each)` : `${name} · ${m.capKw.toFixed(1)} kW`;
            })();
        const proposed = `${proposedModel}\n${cond}\nOn-coil: ${formatProposedOnCoil(m)}`;
        const status = multi ? `OK · ${m.unitsNeeded}× parallel` : "OK";
        rowNum += 1;
        tableDataRow([String(rowNum), r.location, requiredCell, `×${r.qty}`, proposed, status], true, 48);
      }
      tableTotalRow("PACKAGE TOTAL", pkgReqKw, pkgPropKw);
      y += 10;
    }

    if (splitResults.length) {
      const BRAND_DISPLAY = { toshiba: "Toshiba", tcl: "TCL", skm: "SKM" };
      const brandTitle = BRAND_DISPLAY[splitBrand] || (String(splitBrand || "").charAt(0).toUpperCase() + String(splitBrand || "").slice(1));
      section(`Split (${brandTitle})`);
      tableHeader();
      let splitReqKw = 0, splitPropKw = 0;
      for (const { row: r, match: m, error } of splitResults) {
        splitReqKw += r.requiredKw * r.qty;
        totalReqKw += r.requiredKw * r.qty;
        rowNum += 1;
        const req = formatRequiredBlock(r);
        const requiredCell = `${capCell(r.requiredKw)}\n${req.condTxt}\nOn-coil: ${req.onCoilTxt}`;
        if (error) {
          tableDataRow([String(rowNum), r.location, requiredCell, `×${r.qty}`, error, "VERIFY"], false, 48);
          continue;
        }
        splitPropKw += m.proposedKw * r.qty;
        totalProposedKw += m.proposedKw * r.qty;
        const multi = m.unitsNeeded > 1;
        if (multi) multiUnitLocations.push(r.location);
        const proposedModel = multi
          ? `${m.unitsNeeded}× ${m.label} (${m.capKw.toFixed(1)} kW each)`
          : `${m.label} · ${m.capKw.toFixed(1)} kW`;
        const proposed = `${proposedModel}\n${cond}\nOn-coil: ${formatProposedOnCoil(m)}`;
        const status = multi ? `OK · ${m.unitsNeeded}× parallel` : "OK";
        tableDataRow([String(rowNum), r.location, requiredCell, `×${r.qty}`, proposed, status], true, 48);
      }
      tableTotalRow("SPLIT TOTAL", splitReqKw, splitPropKw);
      y += 10;
    }

    // ── Summary section ─────────────────────────────────────────
    checkPage(90);
    section("Summary");
    const summaryLines = [
      `Total rows: ${rows.length}  (${splitResults.length} split, ${pkgResults.length} package)`,
      `Total required: ${f1(toTr(totalReqKw))} TR (${f1(totalReqKw)} kW)`,
      `Total proposed: ${f1(toTr(totalProposedKw))} TR (${f1(totalProposedKw)} kW)`,
    ];
    if (multiUnitLocations.length) {
      summaryLines.push(`Rows needing multiple units in parallel: ${multiUnitLocations.length} (${multiUnitLocations.join(", ")})`);
    }
    if (skipped && skipped.length) {
      summaryLines.push(`Rows to verify: ${skipped.length}`);
    }
    summaryLines.forEach((line) => {
      checkPage(16);
      doc.fillColor("#111111").font("Helvetica").fontSize(8.5).text(`•  ${line}`, L + 4, y, { width: W - 8 });
      y += 14;
    });
    y += 6;

    // ── Skipped / unreadable rows ───────────────────────────────
    if (skipped && skipped.length) {
      checkPage(40);
      doc.fillColor(WARN).font("Helvetica-Bold").fontSize(7.5)
         .text("ROWS THAT COULD NOT BE READ — VERIFY MANUALLY", L, y);
      y += 14;
      skipped.forEach((s) => {
        checkPage(14);
        doc.fillColor("#555555").font("Helvetica").fontSize(8)
           .text(`• ${s.location || s.raw || "(unreadable)"}`, L + 4, y);
        y += 13;
      });
    }

    // ── Footer ───────────────────────────────────────────────────
    checkPage(30);
    y += 8;
    doc.rect(L, y, W, 1).fill("#cccccc");
    y += 6;
    doc.fillColor(MUT).font("Helvetica").fontSize(7)
       .text(
         "Schedule / BOQ Selection Report · Selections are re-derived from the consultant's required " +
         "capacity using Mannai's own catalogue. Verify against manufacturer selection software before submittal.",
         L, y, { width: W, lineGap: 1 }
       );

    doc.end();
  });
}

module.exports = { generateSchedulePdf };
