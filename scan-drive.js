// Run: node scan-drive.js path/to/sa.json
// Lists every file in the HVACBOT Drive folder grouped by subfolder.
// Use this output to update brand-docs.js with new or changed files.

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

async function main() {
  const keyFile = process.argv[2];
  if (!keyFile) { console.error("Usage: node scan-drive.js path/to/sa.json"); process.exit(1); }

  const env = fs.readFileSync(".env", "utf8");
  const rootMatch = env.match(/DRIVE_FOLDER_ID=([^\r\n]+)/);
  if (!rootMatch) { console.error("DRIVE_FOLDER_ID not found in .env"); process.exit(1); }
  const rootId = rootMatch[1].trim();

  const creds = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
  const drive = google.drive({ version: "v3", auth });

  const folderNames = { [rootId]: "(root)" };
  const toVisit = [rootId];
  const allFiles = [];

  while (toVisit.length) {
    const folderId = toVisit.shift();
    let pageToken;
    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType)",
        pageSize: 200,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of res.data.files || []) {
        if (f.mimeType === "application/vnd.google-apps.folder") {
          folderNames[f.id] = f.name;
          toVisit.push(f.id);
        } else {
          allFiles.push({ folder: folderNames[folderId] || "?", name: f.name, id: f.id });
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }

  allFiles.sort((a, b) => (a.folder + a.name).localeCompare(b.folder + b.name));

  console.log("\n=== HVACBOT Drive File Index ===\n");
  let lastFolder = "";
  for (const f of allFiles) {
    if (f.folder !== lastFolder) {
      console.log(`\n📁 ${f.folder}`);
      lastFolder = f.folder;
    }
    console.log(`   ${f.name}`);
    console.log(`      ID: ${f.id}`);
  }
  console.log(`\nTotal: ${allFiles.length} files\n`);
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });
