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

// ---- Recursive listing of everything under the parent folder (saved) ----
// Lets the bot find files by name without any sheet entry. Drop a PDF in the
// folder (or any subfolder) and it becomes requestable automatically.
//
// The crawl is slow (one Drive call per folder page), so the result is saved
// in SQLite and only re-crawled on request once it is older than staleMs.
// Nothing runs on a timer: the app can sleep, wake, read the saved list and
// only then decide whether to refresh.

// One crawled Drive file as a library record. Optional fields are left out
// rather than set to null so a record read back from the database is
// identical to the one the crawl produced.
function libraryRecord(f, folder) {
  const rec = { ...toIndexRecord(f, folder), mimeType: f.mimeType };
  if (f.size != null && f.size !== "" && Number.isFinite(Number(f.size))) rec.size = Number(f.size);
  if (f.md5Checksum) rec.md5 = f.md5Checksum;
  if (f.modifiedTime) rec.modifiedTime = f.modifiedTime;
  return rec;
}

// Walk the folder tree breadth-first and return { files, folders }. Reads
// Drive only; saves nothing.
async function crawlDrive({ getDrive: driveClient, folderId }) {
  if (!folderId) return { files: [], folders: 0 };
  const drive = await driveClient();
  const collected = [];
  // folderPaths stores the FULL path for each folder id, e.g.
  // "Catalogues/Hisense VRF" — so a file inside a brand sub-folder still
  // inherits the "Catalogues" ancestor and passes the doc-type filter. The
  // parent folder itself is recorded as "(root)".
  const folderPaths = { [folderId]: "(root)" };
  const toVisit = [folderId];
  let foldersVisited = 0;

  while (toVisit.length) {
    const current = toVisit.shift();
    foldersVisited++;
    let pageToken;
    do {
      const res = await withRetry(() => drive.files.list({
        q: `'${current}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, size, md5Checksum, modifiedTime)",
        pageSize: 100,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }));
      for (const f of res.data.files || []) {
        if (f.mimeType === "application/vnd.google-apps.folder") {
          // Build full path so nested folders inherit their ancestors' names
          const parentPath = folderPaths[current] || "(root)";
          folderPaths[f.id] = parentPath === "(root)" ? f.name : `${parentPath}/${f.name}`;
          toVisit.push(f.id);
        } else if (isIndexableFile(f)) {
          collected.push(libraryRecord(f, folderPaths[current] || "(root)"));
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }
  return { files: collected, folders: foldersVisited };
}

const LIBRARY_COLUMNS = "id, name, folder, export_mime, mime_type, size, md5, modified_time";

function rowToFile(r) {
  const f = { id: r.id, name: r.name, folder: r.folder };
  if (r.export_mime != null) f.exportMime = r.export_mime;
  if (r.mime_type != null) f.mimeType = r.mime_type;
  if (r.size != null) f.size = r.size;
  if (r.md5 != null) f.md5 = r.md5;
  if (r.modified_time != null) f.modifiedTime = r.modified_time;
  return f;
}

// Same file, different content? By md5 when both sides have one; native
// Google files have none, so they fall back to modifiedTime.
function contentChanged(was, now) {
  if (was.md5 && now.md5) return was.md5 !== now.md5;
  return (was.modifiedTime || null) !== (now.modifiedTime || null);
}

function diffLibrary(oldFiles, newFiles) {
  const was = new Map(oldFiles.map((f) => [f.id, f]));
  const now = new Map(newFiles.map((f) => [f.id, f]));
  const added = [], changed = [], removed = [];
  for (const f of newFiles) {
    const old = was.get(f.id);
    if (!old) added.push(f);
    else if (contentChanged(old, f)) changed.push(f);
  }
  for (const f of oldFiles) if (!now.has(f.id)) removed.push(f);
  return { added, changed, removed };
}

// db: an open database (lib/db.js). getDrive: async () => Drive client.
// now: epoch-ms clock (injectable for tests). A list older than staleMs is
// still served at once; one background refresh is started to replace it.
function createLibraryIndex({ db, getDrive: driveClient, folderId, now = Date.now, staleMs = 10 * 60 * 1000 }) {
  const handlers = [];
  let cache = null; // { files, byId, refreshedAt }, null until a list is saved or loaded
  let inflight = null;

  function remember(files, refreshedAt) {
    cache = { files, byId: new Map(files.map((f) => [f.id, f])), refreshedAt };
    return cache;
  }

  // The saved list, or null when none has ever been saved.
  function saved() {
    if (cache) return cache;
    const state = db.prepare("SELECT refreshed_at FROM library_state WHERE id = 1").get();
    if (!state) return null;
    const rows = db.prepare(`SELECT ${LIBRARY_COLUMNS} FROM library_files ORDER BY seq`).all();
    return remember(rows.map(rowToFile), state.refreshed_at);
  }

  // One transaction: a failure leaves the previous list untouched.
  function save(files, refreshedAt) {
    const insert = db.prepare(
      `INSERT INTO library_files (seq, ${LIBRARY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM library_files");
      files.forEach((f, i) => insert.run(
        i, f.id, f.name, f.folder, f.exportMime ?? null, f.mimeType ?? null,
        f.size ?? null, f.md5 ?? null, f.modifiedTime ?? null
      ));
      db.prepare(
        "INSERT INTO library_state (id, refreshed_at) VALUES (1, ?) " +
        "ON CONFLICT (id) DO UPDATE SET refreshed_at = excluded.refreshed_at"
      ).run(refreshedAt);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  async function doRefresh() {
    const { files, folders } = await crawlDrive({ getDrive: driveClient, folderId });
    const before = saved();
    const old = before ? before.files : [];
    // A Drive hiccup or a wrong folder id can look like an empty library. It
    // must not wipe the list the bot is working from.
    if (!files.length && old.length) {
      console.error(`⚠️  Library crawl came back empty; keeping the saved list of ${old.length} files`);
      throw new Error(`Library crawl came back empty; kept the saved list of ${old.length} files`);
    }
    const result = diffLibrary(old, files);
    const at = now();
    save(files, at);
    remember(files, at);
    console.log(
      `🗂️  Indexed ${files.length} files across ${folders} folder(s) ` +
      `(${result.added.length} added, ${result.changed.length} changed, ${result.removed.length} removed)`
    );
    for (const fn of handlers) {
      // Not awaited: a slow handler (PDF indexing) must not hold up the refresh.
      try {
        Promise.resolve(fn(files.slice(), result)).catch((err) =>
          console.error("Library onRefresh handler failed:", err && err.message));
      } catch (err) {
        console.error("Library onRefresh handler failed:", err && err.message);
      }
    }
    return result;
  }

  // Crawl now and save. Concurrent callers share one crawl.
  function refresh() {
    if (!inflight) inflight = doRefresh().finally(() => { inflight = null; });
    return inflight;
  }

  async function list() {
    let c = saved();
    if (!c) {
      await refresh(); // nothing saved yet: the first caller waits for the crawl
      c = saved();
    } else if (now() - c.refreshedAt > staleMs && !inflight) {
      refresh().catch((err) => console.error("Library refresh failed:", err && err.message));
    }
    return c.files.slice();
  }

  // Reads the saved list only, so it works straight after a restart and
  // never crawls. Null for an unknown id or before any list exists.
  function findById(id) {
    const c = saved();
    return (c && c.byId.get(id)) || null;
  }

  function onRefresh(fn) { handlers.push(fn); }

  return { list, refresh, findById, onRefresh };
}

// The app's own instance, made on first use so requiring this module never
// opens a database. Later code (search, PDF indexing) shares it.
let libraryIndex = null;
function getLibraryIndex() {
  if (!libraryIndex) {
    libraryIndex = createLibraryIndex({
      db: require("./db.js").getDb(),
      getDrive,
      folderId: process.env.DRIVE_FOLDER_ID,
    });
  }
  return libraryIndex;
}

async function listFolderFiles() {
  if (!process.env.DRIVE_FOLDER_ID) return [];
  return getLibraryIndex().list();
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

// Condense a full Drive folder path for the description line of a list row.
// Shows the last two folders; if that exceeds `limit`, shows only the last
// folder, truncated. WhatsApp caps a row description at 72 characters.
function shortPath(folderPath, limit = 72) {
  const parts = String(folderPath || '').split('/').filter(Boolean);
  if (!parts.length) return '';
  const last2 = parts.slice(-2).join('/');
  if (last2.length <= limit) return last2;
  return parts[parts.length - 1].slice(0, limit);
}

module.exports = {
  listFolderFiles, createLibraryIndex, getLibraryIndex, crawlDrive, isIndexableFile, toIndexRecord, INDEXABLE_EXT, GOOGLE_EXPORT, docTypeFromFilename, folderMatchesDocType, fileMatchesDocType,
  findFilesInFolder, findExactFileInDoc, findDatasheetFiles, findChillerDatasheetFiles, displayName, shortPath,
};
