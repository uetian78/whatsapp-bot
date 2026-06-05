// Uploads FCU DMP and DCMP individual datasheet PDFs to Google Drive.
// Creates "FCU DMP Selections" and "FCU DCMP Selections" subfolders under
// the Datasheets folder (or the root HVACBOT folder if Datasheets not found).
// Usage: node upload-fcu-datasheets.js path/to/sa.json

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const DMP_DIR  = path.join(__dirname, "FCU DMP Datasheets");
const DCMP_DIR = path.join(__dirname, "FCU DCMP Datasheets");

async function main() {
  const keyFile = process.argv[2];
  if (!keyFile) { console.error("Usage: node upload-fcu-datasheets.js path/to/sa.json"); process.exit(1); }

  const env = fs.readFileSync(".env", "utf8");
  const rootMatch = env.match(/DRIVE_FOLDER_ID=([^\r\n]+)/);
  if (!rootMatch) { console.error("DRIVE_FOLDER_ID not found in .env"); process.exit(1); }
  const rootId = rootMatch[1].trim();

  const creds = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/drive"] });
  const drive = google.drive({ version: "v3", auth });

  // Find or create "Datasheets" folder under root
  const datasheetsFolderId = await findOrCreate(drive, rootId, "Datasheets");
  console.log(`📁 Datasheets folder: ${datasheetsFolderId}`);

  // Find or create the two FCU subfolders
  const dmpFolderId  = await findOrCreate(drive, datasheetsFolderId, "FCU DMP Selections");
  const dcmpFolderId = await findOrCreate(drive, datasheetsFolderId, "FCU DCMP Selections");
  console.log(`📁 FCU DMP Selections: ${dmpFolderId}`);
  console.log(`📁 FCU DCMP Selections: ${dcmpFolderId}`);

  // Upload DMP datasheets
  await uploadFolder(drive, DMP_DIR, dmpFolderId, "DMP");
  // Upload DCMP datasheets
  await uploadFolder(drive, DCMP_DIR, dcmpFolderId, "DCMP");

  console.log("\n✅ All FCU datasheets uploaded.");
}

async function findOrCreate(drive, parentId, name) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (res.data.files.length) return res.data.files[0].id;

  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
    fields: "id",
    supportsAllDrives: true,
  });
  console.log(`  Created folder: ${name}`);
  return created.data.id;
}

async function uploadFolder(drive, localDir, folderId, label) {
  const files = fs.readdirSync(localDir).filter(f => f.endsWith(".pdf") && !f.includes("datasheets"));
  console.log(`\nUploading ${files.length} ${label} datasheets...`);

  // Get existing files in folder to skip re-uploads
  const existing = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "files(id, name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 200,
  });
  const existingNames = new Set(existing.data.files.map(f => f.name));

  for (const filename of files) {
    if (existingNames.has(filename)) {
      console.log(`  ⏭  Skip (exists): ${filename}`);
      continue;
    }
    const filePath = path.join(localDir, filename);
    const media = { mimeType: "application/pdf", body: fs.createReadStream(filePath) };
    const res = await drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media,
      fields: "id, name",
      supportsAllDrives: true,
    });
    console.log(`  ✅ ${filename} (${res.data.id})`);
  }
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });
