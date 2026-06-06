// ============================================================
//  BRAND DOCUMENT MAP  —  brand-docs.js
//
//  Maps every document (any brand, any type) to its EXACT filename
//  as stored on Google Drive. The bot does a direct lookup here
//  BEFORE falling back to AI matching — so this is fast and reliable.
//
//  HOW TO UPDATE (when new files are added):
//  1. Ask Claude to "scan google drive and update brand-docs"  OR
//  2. Manually add an entry below and push — Render auto-deploys.
//
//  ENTRY FORMAT:
//  {
//    name     : "Display name shown to user",
//    keywords : ["keyword1", "keyword2", ...],   // what users might type
//    files: [
//      { type: "Catalogue", filename: "ExactFilename.pdf" },
//      { type: "IOM",       filename: "ExactIOMFilename.pdf" },
//      { type: "General",   filename: "SomeOtherDoc.pdf" },
//    ]
//  }
//
//  RULES:
//  - keywords must be lowercase
//  - filename must match Drive EXACTLY (spaces, caps, dots, extension)
//  - type can be: "Catalogue", "IOM", "Datasheet", "Price List", "General"
//  - if a product has only one file type, set just that one
//
//  Last scanned: 2026-06-06  (177 files, 8 folders)
// ============================================================

const BRAND_DOCS = [

  // ── HISENSE VRF ───────────────────────────────────────────────────────────
  {
    name: "Hisense VRF",
    keywords: ["hisense vrf", "hisense vrv", "hisense", "hisense variable refrigerant", "hisense s5", "hisense vrf s5"],
    files: [
      { type: "Catalogue", filename: "Hisense VRF S5 - Catalogue.pdf" },
    ],
  },

  // ── CHTS THERMOSTAT ───────────────────────────────────────────────────────
  {
    name: "CHTS Thermostat",
    keywords: ["chts", "chts thermostat", "thermostat datasheet", "chts datasheet", "thermostat"],
    files: [
      { type: "Datasheet", filename: "CHTS Thermostat Datasheet.pdf" },
    ],
  },

  // ── MAJOR COMPONENT LIST ──────────────────────────────────────────────────
  {
    name: "APMR-A Major Component List",
    keywords: ["major component list", "mcl", "mcl apmr", "component list", "apmr component", "apmr-a component"],
    files: [
      { type: "General", filename: "MCL - APMR-A1.pdf" },
    ],
  },

  // ── MICROPROCESSOR CONTROLLER ─────────────────────────────────────────────
  {
    name: "Microprocessor Controller (POL6x8 / C600)",
    keywords: ["microprocessor controller", "pol6", "pol6x8", "c600", "microprocessor", "controller package units", "controller manual"],
    files: [
      { type: "General", filename: "023_POL6x8_A6V10990076_en C600.pdf" },
    ],
  },

  // ── VFD FOR PACKAGE UNITS ─────────────────────────────────────────────────
  {
    name: "VFD Commander C",
    keywords: ["vfd", "variable frequency drive", "commander c", "vfd package", "vfd brochure", "commander", "vfd for package"],
    files: [
      { type: "General", filename: "Commander C Brochure.pdf" },
    ],
  },

  // ── FCU DMP / DCMP COMBINED CATALOGUE ────────────────────────────────────
  {
    name: "FCU DMP DCMP Catalogue",
    keywords: ["fcu dmp dcmp", "dmp dcmp catalogue", "fcu dmp catalogue", "fcu dcmp catalogue"],
    files: [
      { type: "Catalogue", filename: "FCU DMP DCMP _catalogue.pdf" },
    ],
  },

  // ── FCU HI-STATIC DYP / DCYP ─────────────────────────────────────────────
  {
    name: "FCU Hi-Static DYP DCYP",
    keywords: ["hi-static dyp", "hi static dyp", "dyp dcyp", "fcu dyp", "fcu dcyp", "dyp", "dcyp"],
    files: [
      { type: "Catalogue", filename: "FCU_Hi-Static DYP DCYP_catalogue.pdf" },
    ],
  },
  {
    name: "FCU Hi-Static DYP DCYP EC",
    keywords: ["hi-static dyp ec", "hi static dyp ec", "dyp dcyp ec", "fcu dyp ec", "fcu dcyp ec", "dyp ec", "dcyp ec"],
    files: [
      { type: "Catalogue", filename: "FCU_Hi-Static DYP DCYP EC_catalogue.pdf" },
    ],
  },

  // ── APMR-V KU VARIANT ────────────────────────────────────────────────────
  {
    name: "APMR-V KU",
    keywords: ["apmr-v ku", "apmrv ku", "apmr v ku", "apmr ku"],
    files: [
      { type: "Catalogue", filename: "APMR-V KU_catalogue.pdf" },
    ],
  },

  // ── Add more brands/files below following the same format ─────────────────
  // {
  //   name: "Brand Product",
  //   keywords: ["keyword1", "keyword2"],
  //   files: [
  //     { type: "Catalogue", filename: "Exact Filename.pdf" },
  //   ],
  // },

];

// ── Lookup helpers ─────────────────────────────────────────────────────────

// Normalize text for matching: lowercase, strip separators.
function norm(s) {
  return (s || "").toLowerCase().replace(/[\s\-_.]/g, "");
}

/**
 * Given user text (and optional doc type), return matching files from BRAND_DOCS.
 * Returns array of { entry, file } objects, or [].
 */
function findBrandDocs(text, docType) {
  const t = (text || "").toLowerCase();
  const results = [];

  for (const entry of BRAND_DOCS) {
    // Check if any keyword appears in the user text
    const matched = entry.keywords.some((kw) => t.includes(kw));
    if (!matched) continue;

    // Filter files by doc type if specified, but for General/Datasheet types
    // always include them regardless of doc type filter (user may not know the type)
    const files = docType
      ? entry.files.filter((f) => {
          const ft = f.type.toLowerCase();
          return ft === docType.toLowerCase() || ft === "general" || ft === "datasheet";
        })
      : entry.files;

    for (const f of files) {
      results.push({ entry, file: f });
    }
  }

  return results;
}

module.exports = { BRAND_DOCS, findBrandDocs };
