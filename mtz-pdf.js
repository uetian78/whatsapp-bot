// ============================================================
//  mtz-pdf.js  —  Trane MTZ selection PDF generator
//  Uses Puppeteer to load the selector HTML, set inputs, run
//  the built-in auto-select, and print the datasheet to PDF.
// ============================================================
const puppeteer = require("puppeteer");
const path = require("path");

const HTML_PATH = path.join(__dirname, "mtz-selector.html");
const FILE_URL  = "file://" + HTML_PATH.replace(/\\/g, "/");

/**
 * Generate a Trane MTZ selection datasheet as a PDF buffer.
 *
 * @param {object} opts
 *   reqTC   – required total cooling in MBtu/h  (e.g. 100)
 *   db      – on-coil dry-bulb  °F              (e.g. 80)
 *   wb      – on-coil wet-bulb  °F              (e.g. 67)
 *   amb     – outdoor ambient   °F              (e.g. 115)
 *   airflow – optional CFM; omit/null → rated   (e.g. 2800)
 *   project – optional project name string
 *   tag     – optional unit tag string
 *
 * @returns {Buffer} PDF buffer, or null if computation failed.
 */
async function generateMtzPdf({ reqTC, db, wb, amb, airflow, project, tag }) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();

    // Load the selector HTML (which embeds all data + logic)
    await page.goto(FILE_URL, { waitUntil: "networkidle0", timeout: 30000 });

    // Inject inputs, run auto-select, switch to manual mode with best model,
    // then call openSheet() to populate the #sheet div.
    const ok = await page.evaluate(
      ({ reqTC, db, wb, amb, airflow, project, tag }) => {
        try {
          // Set state
          S.mode   = "auto";
          S.units  = "imperial";
          S.reqTC  = String(reqTC);
          S.reqSC  = "";
          S.db     = String(db);
          S.wb     = String(wb);
          S.amb    = String(amb);
          S.airflow = airflow != null ? String(airflow) : "";
          S.project = project || "";
          S.tag     = tag     || "";

          // Rank all models and pick the best
          const rk = computeRanking();
          if (!rk || !rk.length) return false;
          const best = rk[0];
          S.model = best.key;
          S.mode  = "manual"; // switch so compute() uses a single model

          // Populate the sheet overlay
          openSheet();
          return true;
        } catch (e) {
          return false;
        }
      },
      { reqTC, db, wb, amb, airflow: airflow || null, project, tag }
    );

    if (!ok) {
      await browser.close();
      return null;
    }

    // The HTML's @media print hides everything except #sheet.
    // Use page.pdf() which respects print media.
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", bottom: "14mm", left: "14mm", right: "14mm" },
    });

    await browser.close();
    return Buffer.from(pdfBuffer);
  } catch (err) {
    if (browser) await browser.close();
    throw err;
  }
}

module.exports = { generateMtzPdf };
