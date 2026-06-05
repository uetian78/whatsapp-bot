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
};

// Does this folder name belong to the given series' datasheet set?
function datasheetFolderForSeries(folderName, seriesName) {
  const f = (folderName || "").toLowerCase().trim();
  const names = DATASHEET_FOLDERS[seriesName];
  if (!names) return false;
  return names.includes(f);
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
    aliases: ["apmr-a", "apmra", "apmr a"],
    catalogue: "APMR-A_catalogue.pdf",
    iom: "APMRA 2025 IOM_IOM.pdf",
  },
  {
    name: "APMR-V",
    aliases: ["apmr-v", "apmrv", "apmr v"],
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
    aliases: ["pac4a", "pac 4a", "pac-4a"],
    catalogue: "PAC4A_catalogue.pdf",
    iom: "PAC4A_IOM.pdf",
  },
  {
    name: "PAC9A",
    aliases: ["pac9a", "pac 9a", "pac-9a"],
    catalogue: "PAC9A_catalogue.pdf",
    iom: null,
  },
  {
    name: "PACF",
    aliases: ["pacf"],
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
    aliases: ["apcy-p", "apcyp", "apcy p"],
    catalogue: "APCY-P_catalogue.pdf",
    iom: "APCY-P_IOM.pdf",
  },
  {
    name: "APCY-H",
    aliases: ["apcy-h", "apcyh", "apcy h"],
    catalogue: "APCY-H_catalogue.pdf",
    iom: "APCY-H IOM_IOM.pdf",
  },
  {
    name: "APCY-E",
    aliases: ["apcy-e", "apcye", "apcy e"],
    catalogue: "APCY-E_catalogue.pdf",
    iom: "APCY-E_IOM.pdf",
  },
  {
    name: "ACMR",
    aliases: ["acmr"],
    catalogue: "ACMR_catalogue.pdf",
    iom: "ACMR IOM_IOM.pdf",
  },
  {
    name: "WPCY",
    aliases: ["wpcy"],
    catalogue: "WPCY_catalogue.pdf",
    iom: null,
  },

  // ---- Condensing units ----
  {
    name: "APCN-S",
    aliases: ["apcn-s", "apcns", "apcn s"],
    catalogue: "APCN-S_catalogue.pdf",
    iom: "APCN-S_IOM.pdf",
  },
  {
    name: "APCN-VVH",
    aliases: ["apcn-vvh", "apcnvvh", "apcn vvh"],
    catalogue: "APCN-VVH_catalogue.pdf",
    iom: "APCNVVH_IOM.pdf",
  },
  {
    name: "APCNVZ",
    aliases: ["apcnvz", "apcn-vz", "apcn vz"],
    catalogue: "APCNVZ 2025_catalogue.pdf",
    iom: null,
  },

  // ---- Condensing / outdoor (ACUV / ACUS) ----
  {
    name: "ACUV-D",
    aliases: ["acuv-d", "acuvd", "acuv d"],
    catalogue: null,
    iom: "ACUV-D_IOM.pdf",
  },
  {
    name: "ACUV-S",
    aliases: ["acuv-s", "acuvs", "acuv s"],
    catalogue: null,
    iom: "ACUV-S_IOM.pdf",
  },
  {
    name: "ACUS",
    aliases: ["acus"],
    catalogue: null,
    iom: "ACUS_IOM.pdf",
  },

  // ---- Computer room / precision ----
  {
    name: "CRAC",
    aliases: ["crac"],
    catalogue: "CRAC_catalogue.pdf",
    iom: "CRAC_IOM.pdf",
  },

  // ---- Air handling units ----
  {
    name: "MAH",
    aliases: ["mah", "modular ahu"],
    catalogue: "MAH_catalogue.pdf",
    iom: "MAH_IOM.pdf",
  },
  {
    name: "HMAH",
    aliases: ["hmah"],
    catalogue: "HMAH_catalogue.pdf",
    iom: "HMAH_IOM.pdf",
  },
  {
    name: "CAH",
    aliases: ["cah", "comfort ahu"],
    catalogue: "CAH_catalogue.pdf",
    iom: "CAH_IOM.pdf",
  },

  // ---- Fan coil units ----
  {
    name: "FCU",
    aliases: ["fcu", "skm fcu", "skmfcu", "fan coil", "fan coil unit"],
    catalogue: "FCU Catalogue_catalogue.pdf",
    iom: "FCU_IOM.pdf",
  },
  {
    name: "FCU Hi-Static",
    aliases: ["fcu hi-static", "fcu hi static", "hi-static fcu", "hi static fcu", "high static fcu"],
    catalogue: "FCU_Hi-Static_catalogue.pdf",
    iom: null,
  },
  {
    name: "FCU Hi-Static EC",
    aliases: ["fcu hi-static ec", "fcu hi static ec", "hi-static ec", "ec fcu"],
    catalogue: "FCU_Hi-Static EC_catalogue.pdf",
    iom: null,
  },

  // ---- Chilled water terminal units (DFC) ----
  {
    name: "DFC Cassette",
    aliases: ["dfc cassette", "dfc chilled water cassette", "chilled water cassette", "cassette"],
    catalogue: "DFC Chilled Water Cassette Type_catalogue.pdf",
    iom: null,
  },
  {
    name: "DFC Ceiling-Floor",
    aliases: ["dfc ceiling", "dfc floor", "dfc ceiling-floor", "chilled water ceiling", "ceiling floor mounted"],
    catalogue: "DFC Chilled Water Ceiling-Floor Mounted_catalogue.pdf",
    iom: null,
  },

  // ---- Specialty ----
  {
    name: "Dehumidification Unit",
    aliases: ["dehumidification", "dehumidifier", "swimpool", "swimming pool", "pool unit"],
    catalogue: "Dehumidification Unit-Swimpool_catalogue.pdf",
    iom: null,
  },
  {
    name: "Ecology Unit",
    aliases: ["ecology unit", "ecology", "seu", "skm ecology"],
    catalogue: "SKM Ecology Unit -SEU_catalogue.pdf",
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
