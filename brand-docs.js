// ============================================================
//  BRAND DOCUMENT MAP  —  brand-docs.js
//
//  Maps every document (any brand, any type) to its EXACT filename
//  as stored on Google Drive. The bot does a direct lookup here
//  BEFORE falling back to AI matching — so this is fast and reliable.
//
//  HOW TO UPDATE (weekly):
//  1. Run:  node scan-drive.js path/to/sa.json
//  2. For any new file, add an entry below (or update an existing one).
//  3. Commit and push — Render auto-deploys.
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
// ============================================================

const BRAND_DOCS = [

  // ── HISENSE ───────────────────────────────────────────────────────────────
  {
    name: "Hisense VRF",
    keywords: ["hisense vrf", "hisense vrv", "hisense", "hisense variable refrigerant"],
    files: [
      { type: "Catalogue", filename: "Hisense VRF Catalogue.pdf" },
    ],
  },

  // ── Add more brands below following the same format ───────────────────────
  // Example:
  // {
  //   name: "Daikin VRV",
  //   keywords: ["daikin vrv", "daikin vrf", "daikin"],
  //   files: [
  //     { type: "Catalogue", filename: "Daikin VRV Catalogue 2025.pdf" },
  //     { type: "IOM",       filename: "Daikin VRV IOM.pdf" },
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

    // Filter files by doc type if specified
    const files = docType
      ? entry.files.filter((f) => f.type.toLowerCase() === docType.toLowerCase())
      : entry.files;

    for (const f of files) {
      results.push({ entry, file: f });
    }
  }

  return results;
}

module.exports = { BRAND_DOCS, findBrandDocs };
