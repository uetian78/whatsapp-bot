// ============================================================
//  Recursive Drive file index (cached) + doc-type/file matching.
//  Doc type is decided by FOLDER (Catalogue(s)/IOM(s)) with the
//  _IOM/_catalogue filename suffix as a secondary signal.
// ============================================================
const { getDrive, withRetry } = require("./google.js");
const { folderToDocType, datasheetFolderForSeries, datasheetCondition, DATASHEET_FOLDERS } = require("../catalogue-map.js");

const { DRIVE_FOLDER_ID } = process.env;

// What counts as a requestable document. Every extension here is already in
// EXT_MIME (lib/wa.js), so WhatsApp can carry it and validatePdfBuffer skips
// the non-PDFs. Spreadsheets and Word docs live in Submittal Files and were
// invisible to every search path until they were added here.
//
const INDEXABLE_EXT = /\.(pdf|xlsx?|docx?|pptx?|csv|png|jpe?g)$/i;

// Native Google Docs/Sheets/Slides have NO stored bytes and NO file
// extension — a plain download 403s. They must be rendered by files.export
// into a real format first. Map each one to what it should become, and to
// the extension we append so the rest of the bot (WhatsApp mime lookup,
// display name, filename matching) treats it like any other document.
const GOOGLE_EXPORT = {
  "application/vnd.google-apps.spreadsheet": {
    ext: "xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  "application/vnd.google-apps.document": {
    ext: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  "application/vnd.google-apps.presentation": {
    ext: "pptx",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
};

function isIndexableFile(file) {
  if (!file) return false;
  if (file.mimeType === "application/vnd.google-apps.folder") return false;
  if (GOOGLE_EXPORT[file.mimeType]) return true;
  return file.mimeType === "application/pdf" || INDEXABLE_EXT.test(file.name || "");
}

// Build the index record for one Drive file. Native Google files get the
// export extension appended to their name — "FCU Coil Connection Sheet"
// becomes "FCU Coil Connection Sheet.xlsx" — so mimeFromName() picks the
// right WhatsApp type, displayName() strips it again for display, and name
// matching behaves exactly as it does for an uploaded file. exportMime rides
// along so the download path knows to call files.export instead.
function toIndexRecord(file, folder) {
  const exp = GOOGLE_EXPORT[file.mimeType];
  if (!exp) return { id: file.id, name: file.name, folder };
  return {
    id: file.id,
    name: `${file.name}.${exp.ext}`,
    folder,
    exportMime: exp.mime,
  };
}

// ---- Recursive listing of all PDFs under the parent folder (cached) ----
// Lets the bot find files by name without any sheet entry. Drop a PDF in the
// folder (or any subfolder) and it becomes requestable automatically.
let fileIndex = { files: [], ts: 0 };
const FILE_CACHE_MS = 2 * 60 * 1000; // refresh at most every 2 minutes

async function listFolderFiles() {
  if (!DRIVE_FOLDER_ID) return [];
  if (Date.now() - fileIndex.ts < FILE_CACHE_MS && fileIndex.files.length) {
    return fileIndex.files;
  }

  const drive = await getDrive();
  const collected = [];
  // Track each folder's name so we know which folder a file lives in
  // (e.g. "Catalogue", "IOM", "Datasheets"). The parent folder itself
  // is recorded under its own name too.
  // folderPaths stores the FULL path for each folder id, e.g.
  // "Catalogues/Hisense VRF" — so a file inside a brand sub-folder still
  // inherits the "Catalogues" ancestor and passes the doc-type filter.
  const folderPaths = { [DRIVE_FOLDER_ID]: "(root)" };
  const toVisit = [DRIVE_FOLDER_ID];
  let foldersVisited = 0;

  while (toVisit.length) {
    const folderId = toVisit.shift();
    foldersVisited++;
    let pageToken;
    do {
      const res = await withRetry(() => drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType)",
        pageSize: 100,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }));
      for (const f of res.data.files || []) {
        if (f.mimeType === "application/vnd.google-apps.folder") {
          // Build full path so nested folders inherit their ancestors' names
          const parentPath = folderPaths[folderId] || "(root)";
          folderPaths[f.id] = parentPath === "(root)" ? f.name : `${parentPath}/${f.name}`;
          console.log(`   ↳ subfolder found: ${folderPaths[f.id]} (${f.id})`);
          toVisit.push(f.id);
        } else if (isIndexableFile(f)) {
          collected.push(toIndexRecord(f, folderPaths[folderId] || "(root)"));
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }

  fileIndex = { files: collected, ts: Date.now() };
  console.log(
    `🗂️  Indexed ${collected.length} files across ${foldersVisited} folder(s): ` +
    collected.map((f) => `${f.folder}/${f.name}`).join(", ")
  );
  return collected;
}

// Find the right file for a series + doc type.
//
// IMPORTANT design facts (from the real Drive layout):
//   - The DOC TYPE is decided by the FOLDER, not the filename:
//       * Catalogue files live in a folder named "Catalogue(s)" and are named
//         just by series, e.g. "APMR-A.pdf", "APCY-H.pdf", "ACMR.pdf".
//         (No word "Catalogue" in the filename.)
//       * IOM files live in a folder named "IOM(s)" and DO carry "IOM" in the
//         name, e.g. "ACMR IOM.pdf", "APMRA 2025 IOM.pdf".
//   - So we match the FOLDER for the doc type, then match only the SERIES
//     prefix within the filename. Any extra tokens (year, version, stray
//     dots like "APMR-A. 2025.pdf") are ignored.
//
// Detect doc type from filename suffix — _IOM.pdf or _catalogue.pdf.
// This is the primary signal now that all files are renamed consistently.
function docTypeFromFilename(filename) {
  const n = (filename || "").toLowerCase();
  if (n.endsWith("_iom.pdf")) return "IOM";
  if (n.endsWith("_catalogue.pdf")) return "Catalogue";
  return null;
}

// docType is "Catalogue" or "IOM". Match by folder path (any segment), not just
// the immediate parent — so files in "Catalogues/Hisense VRF/" still count as Catalogues.
function folderMatchesDocType(folderPath, docType) {
  // Split full path (e.g. "Catalogues/Hisense VRF") and check each segment.
  const segments = (folderPath || "").split("/").map((s) => s.toLowerCase().trim());
  if (docType === "Catalogue") return segments.some((s) => /^catalogues?$/.test(s) || /^catalog$/.test(s));
  if (docType === "IOM") return segments.some((s) => /^ioms?$/.test(s));
  return false;
}

function fileMatchesDocType(file, docType) {
  return folderMatchesDocType(file.folder, docType) || docTypeFromFilename(file.name) === docType;
}

function findFilesInFolder(seriesName, files, docType) {
  const inFolder = files.filter((f) => fileMatchesDocType(f, docType));

  const norm = (s) => s.toLowerCase().replace(/[\s\-_.]/g, "");
  const seriesToken = norm(seriesName); // e.g. "apmra" for "APMR-A"
  const docWord = docType.toLowerCase(); // "catalogue" or "iom"

  const scored = [];
  for (const f of inFolder) {
    const base = norm(f.name.replace(/\.[^.]+$/, "")); // e.g. "apmra2025", "acmriom"
    if (!base.startsWith(seriesToken)) continue; // series must lead the name

    // Prevent a shorter series matching a longer one (APMR vs APMR-A).
    // The char right after the series prefix must NOT be a letter — UNLESS
    // those letters are the doc-type word itself (e.g. "acmr" + "iom" ->
    // "acmriom" is valid; "apmr" + "a..." is NOT valid for series APMR).
    const after = base.slice(seriesToken.length); // e.g. "2025", "iom", "a2025iom"
    if (/^[a-z]/.test(after) && !after.startsWith(docWord)) continue;

    // Rank: exact series name first (e.g. "apmra"), then series + doc word
    // (e.g. "acmriom"), then series + other extras (e.g. "apmra2025"). This
    // makes "APMR-A.pdf" win over "APMR-A. 2025.pdf" when both exist.
    let rank = 2;
    if (base === seriesToken) rank = 0;
    else if (after.startsWith(docWord)) rank = 1;
    scored.push({ f, rank });
  }

  if (!scored.length) return [];
  const best = Math.min(...scored.map((s) => s.rank));
  return scored.filter((s) => s.rank === best).map((s) => s.f);
}

// Find an indexed file by its EXACT name within a given doc-type folder.
// Folder is matched via the catalogue-map's folderToDocType (handles
// "Catalogues"/"Catalogue" and "IOM"/"IOMs"). Filename match is exact, but
// tolerant of a stray trailing space (Drive has "APCNVVH .pdf").
function findExactFileInDoc(exactName, docType, files) {
  if (!exactName) return null;
  const want = exactName.trim().toLowerCase();
  for (const f of files) {
    if (f.name.trim().toLowerCase() !== want) continue;
    if (folderToDocType(f.folder) === docType || docTypeFromFilename(f.name) === docType) return f;
  }
  return null;
}

// Find datasheet files for a series + code. Looks only inside that series'
// datasheet subfolder(s) and matches files whose name contains the 5-digit
// code. Returns an array of { name, id, condition } (condition = T1/T3/null).
function findDatasheetFiles(series, code, files) {
  const out = [];
  for (const f of files) {
    if (!datasheetFolderForSeries(f.folder, series)) continue;
    // the code must appear in the filename
    const re = new RegExp(`\\b${code}\\b`);
    if (!re.test(f.name)) continue;
    out.push({ name: f.name, id: f.id, condition: datasheetCondition(f.name) });
  }
  return out;
}

// Chiller datasheets: the 4-digit code is embedded in the model string
// (e.g. "APCY5530TH..."), so word-boundaries don't apply. Match by checking
// any path segment against the series' datasheet folder names and the code as
// a substring of the normalized filename. Returns matching file objects.
function findChillerDatasheetFiles(series, code, files) {
  const aliases = DATASHEET_FOLDERS[series] || [];
  const out = [];
  for (const f of files) {
    const segs = (f.folder || "").toLowerCase().split("/").map((s) => s.trim());
    if (!segs.some((s) => aliases.includes(s))) continue;
    const norm = f.name.toLowerCase().replace(/[\s\-_.]/g, "");
    if (norm.includes(code)) out.push(f);
  }
  return out;
}

// Clean display name: strip _IOM / _catalogue suffix and extension.
function displayName(file) {
  return file.name
    .replace(/_IOM\.pdf$/i, "")
    .replace(/_catalogue\.pdf$/i, "")
    .replace(INDEXABLE_EXT, "")
    .trim();
}

module.exports = {
  listFolderFiles, isIndexableFile, toIndexRecord, INDEXABLE_EXT, GOOGLE_EXPORT, docTypeFromFilename, folderMatchesDocType, fileMatchesDocType,
  findFilesInFolder, findExactFileInDoc, findDatasheetFiles, findChillerDatasheetFiles, displayName,
};
