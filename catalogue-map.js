// ============================================================
//  DETERMINISTIC CATALOGUE / IOM MAP
//  Exact filename lookup — no fuzzy matching, no AI.
//
//  Built from the real Drive layout:
//     Catalogue/Catalogues/   -> product catalogues
//     Catalogue/IOM/          -> installation/operation/maintenance manuals
//
//  Each entry maps a product SERIES to:
//     name      : canonical label shown to the user / used on buttons
//     aliases   : everything a user might type (lowercase, normalized-friendly)
//     catalogue : EXACT filename in the Catalogues folder (or null if none)
//     iom       : EXACT filename in the IOM folder (or null if none)
//
//  To add/fix a file: edit the exact filename string here. That's it.
//  Filenames must match Drive EXACTLY (including spaces, dots, the .pdf ext).
// ============================================================

// Folder-name variants we accept for each document type (case-insensitive).
const FOLDER_NAMES = {
  Catalogue: ["catalogues", "catalogue", "catalog"],
  IOM: ["iom", "ioms"],
};

// ============================================================
//  DATASHEETS
//  Live in subfolders under "Datasheets":
//     Datasheets/APMR Selections/    -> "APMR <code> - T1.pdf" / "- T3.pdf"
//     Datasheets/APMR-A Selections/  -> "APMRA <code> A - T1.pdf" / "- T3.pdf"
//     Datasheets/PAC4A selections/   -> "PAC4A <code>.pdf"  (single, no T1/T3)
//
//  A datasheet request names a SERIES + a 5-digit CODE, e.g.
//  "APMR 52300 datasheet". We then find every indexed datasheet file whose
//  name contains that code AND sits in that series' selection subfolder.
//  - 2 files (T1 + T3) -> ask the user which condition (buttons)
//  - 1 file            -> send directly
// ============================================================

// Which selection subfolder belongs to which series (folder-name match,
// case-insensitive, space/“selection(s)” tolerant). The KEY is the canonical
// series name from CATALOGUE_MAP.
const DATASHEET_FOLDERS = {
  "APMR-A": ["apmr-a selections", "apmra selections", "apmr-a selection", "apmra selection"],
  "APMR":   ["apmr selections", "apmr selection"],
  "PAC4A":  ["pac4a selections", "pac4a selection"],
  // Air-cooled screw chillers. Top-level Drive folders (case-insensitive),
  // matched by any path segment so nesting under "Datasheets/" still works.
  "APCY-E": ["apcy-e datasheets", "apcye datasheets", "apcy-e datasheet"],
  "APCY-H": ["apcy-h datasheets", "apcyh datasheets", "apcy-h datasheet"],
};

// Does this folder name belong to the given series' datasheet set?
function datasheetFolderForSeries(folderName, seriesName) {
  const names = DATASHEET_FOLDERS[seriesName];
  if (!names) return false;
  // Match ANY path segment, so a nested folder like "Datasheets/APMR Selections"
  // still resolves (the file index stores the full path, not just the leaf).
  const segs = (folderName || "").toLowerCase().split("/").map((s) => s.trim());
  return segs.some((s) => names.includes(s));
}

// Series that actually have a datasheet folder.
function seriesHasDatasheets(seriesName) {
  return !!DATASHEET_FOLDERS[seriesName];
}

// Pull the condition (T1 / T3) out of a datasheet filename, or null.
function datasheetCondition(filename) {
  const m = (filename || "").match(/\bT\s*([13])\b/i);
  return m ? "T" + m[1] : null;
}


// SERIES TABLE
// Order matters for alias detection: longer / more specific series first
// (so "apmr-a" is detected before "apmr", "apcy-p" before a bare "apcy", etc.).
const CATALOGUE_MAP = [
  // ---- Packaged units ----
  {
    name: "APMR-A",
    aliases: [
      "apmr-a", "apmra", "apmr a",
      // natural-language variants for packaged DX units
      "package unit", "packaged unit", "packaged ac", "package ac",
      "rooftop unit", "rooftop ac", "rooftop", "dx unit", "dx packaged",
    ],
    catalogue: "APMR-A. 2025_catalogue.pdf",
    iom: "APMRA 2025 IOM_IOM.pdf",
  },
  {
    name: "APMR-V",
    aliases: ["apmr-v", "apmrv", "apmr v", "vertical packaged", "vertical package unit"],
    catalogue: "APMR-V_catalogue.pdf",
    iom: "APMR-V_IOM.pdf",
  },
  {
    name: "APMR",
    aliases: ["apmr"],
    catalogue: "APMR_catalogue.pdf",
    iom: "APMR I.O.M_IOM.pdf",
  },
  {
    name: "AUMR-A",
    aliases: ["aumr-a", "aumra", "aumr a", "aumr"],
    catalogue: "AUMR-A 2025_catalogue.pdf",
    iom: "AUMR-A IOM 2025_IOM.pdf",
  },

  // ---- Fresh air / DOAS / specialty packaged ----
  {
    name: "PAC4A",
    aliases: [
      "pac4a", "pac 4a", "pac-4a",
      // natural-language: fresh air / DOAS / makeup air unit
      "fresh air unit", "fresh air", "doas unit", "doas",
      "100% fresh air", "100 fresh air", "outdoor air unit", "oau",
      "make up air unit", "makeup air", "mau",
    ],
    catalogue: "PAC4A_catalogue.pdf",
    iom: "PAC4A_IOM.pdf",
  },
  {
    name: "PAC9A",
    aliases: ["pac9a", "pac 9a", "pac-9a", "pac 9", "fresh air 9a"],
    catalogue: "PAC9A_catalogue.pdf",
    iom: null,
  },
  {
    name: "PACF",
    aliases: ["pacf", "pac f", "fan assisted package", "fan assisted"],
    catalogue: null,
    iom: "PACF_IOM.pdf",
  },
  {
    name: "PACS-CS",
    aliases: ["pacs-cs", "pacscs", "pacs cs"],
    catalogue: null,
    iom: "PACS-CS_IOM.pdf",
  },
  {
    name: "PACS C",
    aliases: ["pacs c", "pacsc", "pacs c 60hz", "pacs"],
    catalogue: "PACS C 60Hz_catalogue.pdf",
    iom: null,
  },
  {
    name: "PACV-D",
    aliases: ["pacv-d", "pacvd", "pacv d"],
    catalogue: "PACV DEXM_catalogue.pdf",
    iom: "PACV-D_IOM.pdf",
  },
  {
    name: "PACV-S",
    aliases: ["pacv-s", "pacvs", "pacv s"],
    catalogue: null,
    iom: "PACV-S_IOM.pdf",
  },

  // ---- Chillers ----
  {
    name: "APCY-P",
    aliases: [
      "apcy-p", "apcyp", "apcy p",
      "scroll chiller", "air cooled scroll chiller",
    ],
    catalogue: "APCY-P_catalogue.pdf",
    iom: "APCY-P_IOM.pdf",
  },
  {
    name: "APCY-H",
    aliases: [
      "apcy-h", "apcyh", "apcy h",
      "magnetic bearing chiller", "magnetic chiller", "inverter chiller",
    ],
    catalogue: "APCY-H_catalogue.pdf",
    iom: "APCY-H IOM_IOM.pdf",
  },
  {
    name: "APCY-E",
    aliases: [
      "apcy-e", "apcye", "apcy e",
      "screw chiller", "air cooled screw chiller", "air cooled screw",
    ],
    catalogue: "APCY-E_catalogue.pdf",
    iom: "APCY-E_IOM.pdf",
  },
  {
    name: "ACMR",
    aliases: ["acmr", "air cooled modular", "modular chiller", "modular refrigeration"],
    catalogue: "ACMR_catalogue.pdf",
    iom: "ACMR IOM_IOM.pdf",
  },
  {
    name: "WPCY",
    aliases: [
      "wpcy",
      "water cooled chiller", "water chiller", "water-cooled chiller",
      "water cooled packaged", "wpcy chiller",
    ],
    catalogue: "WPCY_catalogue.pdf",
    iom: null,
  },

  // ---- Condensing units ----
  {
    name: "APCN-S",
    aliases: [
      "apcn-s", "apcns", "apcn s",
      "condensing unit", "skm condensing unit", "scroll condensing",
    ],
    catalogue: "APCN-S_catalogue.pdf",
    iom: "APCN-S_IOM.pdf",
  },
  {
    name: "APCN-VVH",
    aliases: [
      "apcn-vvh", "apcnvvh", "apcn vvh",
      "vvh condensing", "variable speed condensing",
    ],
    catalogue: "APCN-VVH_catalogue.pdf",
    iom: "APCNVVH_IOM.pdf",
  },
  {
    name: "APCNVZ",
    aliases: ["apcnvz", "apcn-vz", "apcn vz", "vz condensing"],
    catalogue: "APCNVZ 2025_catalogue.pdf",
    iom: null,
  },

  // ---- Condensing / outdoor (ACUV / ACUS) ----
  {
    name: "ACUV-D",
    aliases: ["acuv-d", "acuvd", "acuv d", "acuv dual"],
    catalogue: null,
    iom: "ACUV-D_IOM.pdf",
  },
  {
    name: "ACUV-S",
    aliases: ["acuv-s", "acuvs", "acuv s", "acuv single"],
    catalogue: null,
    iom: "ACUV-S_IOM.pdf",
  },
  {
    name: "ACUS",
    aliases: ["acus", "acus unit"],
    catalogue: null,
    iom: "ACUS_IOM.pdf",
  },

  // ---- Computer room / precision ----
  {
    name: "CRAC",
    aliases: [
      "crac",
      "computer room ac", "computer room air conditioning", "precision ac",
      "precision air conditioning", "precision cooling", "server room ac",
    ],
    catalogue: "CRAC_catalogue.pdf",
    iom: "CRAC_IOM.pdf",
  },

  // ---- Air handling units ----
  {
    name: "MAH",
    aliases: [
      "mah", "modular ahu",
      // bare "ahu" maps to MAH as the primary SKM AHU product
      "ahu", "air handling unit", "air handler",
      "modular air handling unit", "modular air handler",
    ],
    catalogue: "MAH_catalogue.pdf",
    iom: "MAH_IOM.pdf",
  },
  {
    name: "HMAH",
    aliases: [
      "hmah", "hybrid mah",
      "horizontal ahu", "horizontal air handling unit",
    ],
    catalogue: "HMAH_catalogue.pdf",
    iom: "HMAH_IOM.pdf",
  },
  {
    name: "CAH",
    aliases: [
      "cah", "comfort ahu",
      "comfort air handling unit", "comfort air handler", "standard ahu",
    ],
    catalogue: "CAH_catalogue.pdf",
    iom: "CAH_IOM.pdf",
  },

  // ---- Fan coil units ----
  {
    name: "FCU",
    aliases: [
      "fcu", "skm fcu", "skmfcu", "fan coil", "fan coil unit",
      // DMP/DCMP are the two FCU series — route to combined catalogue/IOM
      "dmp", "dcmp", "dmp fcu", "dcmp fcu",
      "chilled water fan coil", "cwfc",
    ],
    catalogue: "FCU DMP DCMP _catalogue.pdf",
    iom: "FCU_IOM.pdf",
  },
  {
    name: "FCU Hi-Static",
    aliases: [
      "fcu hi-static", "fcu hi static", "hi-static fcu", "hi static fcu", "high static fcu",
      "dyp fcu", "dcyp fcu", "dyp", "dcyp",
    ],
    catalogue: "FCU_Hi-Static DYP DCYP_catalogue.pdf",
    iom: null,
  },
  {
    name: "FCU Hi-Static EC",
    aliases: [
      "fcu hi-static ec", "fcu hi static ec", "hi-static ec", "ec fcu",
      "dyp ec", "dcyp ec",
    ],
    catalogue: "FCU_Hi-Static DYP DCYP EC_catalogue.pdf",
    iom: null,
  },

  // ---- Chilled water terminal units (DFC) ----
  {
    name: "DFC Cassette",
    aliases: [
      "dfc cassette", "dfc chilled water cassette", "chilled water cassette", "cassette",
      "dfc", "dfc unit",
    ],
    catalogue: "DFC Chilled Water Cassette Type_catalogue.pdf",
    iom: null,
  },
  {
    name: "DFC Ceiling-Floor",
    aliases: [
      "dfc ceiling", "dfc floor", "dfc ceiling-floor", "chilled water ceiling", "ceiling floor mounted",
      "ceiling floor unit", "dfc ceiling floor",
    ],
    catalogue: "DFC Chilled Water Ceiling-Floor Mounted_catalogue.pdf",
    iom: null,
  },

  // ---- Specialty ----
  {
    name: "Dehumidification Unit",
    aliases: [
      "dehumidification", "dehumidifier", "swimpool", "swimming pool", "pool unit",
      "pool dehumidifier", "pool ac", "dehumidification unit",
    ],
    catalogue: "Dehumidification Unit-Swimpool_catalogue.pdf",
    iom: null,
  },
  {
    name: "Ecology Unit",
    aliases: ["ecology unit", "ecology", "seu", "skm ecology", "skm seu"],
    catalogue: "SKM Ecology Unit -SEU_catalogue.pdf",
    iom: null,
  },

  // ---- Splits (in-house SKM) ----
  {
    name: "Hi-Wall Non-Inverter",
    aliases: [
      "hi wall non inverter", "wall mounted non inverter",
      "non inverter split", "skm hi wall", "hi-wall non-inverter",
    ],
    catalogue: "SKM Wall Mounted Hi Wall Split - Non Inverter (Qatar).pdf",
    iom: null,
  },
  {
    name: "Sierra Ducted Split",
    aliases: ["sierra", "sierra series", "sierra ducted split", "ducted split sierra"],
    catalogue: "SKM Ducted Split_Catalogue - Sierra Series - R0 CBU_RX+DDP 052c 50Hz (1).pdf",
    iom: null,
  },
];

// ------- lookup helpers -------

// Normalize for alias comparison: lowercase, collapse separators.
function normLoose(s) {
  return (s || "").toLowerCase().replace(/[\s\-_.]/g, "").trim();
}

// Detect which document type a folder name represents.
// Returns "Catalogue", "IOM", or null.
function folderToDocType(folderName) {
  const f = (folderName || "").toLowerCase().trim();
  if (FOLDER_NAMES.Catalogue.includes(f)) return "Catalogue";
  if (FOLDER_NAMES.IOM.includes(f)) return "IOM";
  return null;
}

// Detect the series a user's text refers to. Returns the series ENTRY
// (object) or null. Longer aliases are tested first because the table is
// ordered specific -> general, and we also sort matches by alias length.
function detectSeriesEntry(text) {
  const t = ` ${(text || "").toLowerCase().trim()} `;
  let best = null;
  let bestLen = 0;
  for (const entry of CATALOGUE_MAP) {
    for (const a of entry.aliases) {
      const safe = a.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
      const re = new RegExp(`(^|[\\s,.])${safe}([\\s,.]|$)`);
      if (re.test(t) && a.length > bestLen) {
        best = entry;
        bestLen = a.length;
      }
    }
  }
  return best;
}

// Given a series entry + docType, return the EXACT filename (or null).
function filenameFor(entry, docType) {
  if (!entry) return null;
  return docType === "IOM" ? entry.iom : entry.catalogue;
}

module.exports = {
  CATALOGUE_MAP,
  FOLDER_NAMES,
  DATASHEET_FOLDERS,
  normLoose,
  folderToDocType,
  detectSeriesEntry,
  filenameFor,
  datasheetFolderForSeries,
  seriesHasDatasheets,
  datasheetCondition,
};
