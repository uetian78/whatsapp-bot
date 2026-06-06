// Run: node scan-drive.js
// Lists every file in the HVACBOT Drive folder grouped by subfolder.
// Use this output to update brand-docs.js with new or changed files.

const fs = require("fs");
const { google } = require("googleapis");

async function main() {
  const env = fs.readFileSync(".env", "utf8");

  // Read DRIVE_FOLDER_ID
  const rootMatch = env.match(/DRIVE_FOLDER_ID=([^\r\n]+)/);
  if (!rootMatch) { console.error("DRIVE_FOLDER_ID not found in .env"); process.exit(1); }
  const rootId = rootMatch[1].trim();

  // Read GOOGLE_SERVICE_ACCOUNT_JSON (stored as outer-quoted JSON string in .env)
  const idx = env.indexOf("GOOGLE_SERVICE_ACCOUNT_JSON=");
  if (idx === -1) { console.error("GOOGLE_SERVICE_ACCOUNT_JSON not found in .env"); process.exit(1); }
  const rest = env.substring(idx + "GOOGLE_SERVICE_ACCOUNT_JSON=".length);
  const match = rest.match(/^"([\s\S]+?)"\s*\n/);
  if (!match) { console.error("Could not parse GOOGLE_SERVICE_ACCOUNT_JSON"); process.exit(1); }
  const creds = JSON.parse(JSON.parse('"' + match[1] + '"'));

  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
  const drive = google.drive({ version: "v3", auth });

  const folderPaths = { [rootId]: "(root)" };
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
          const parentPath = folderPaths[folderId] || "(root)";
          folderPaths[f.id] = parentPath === "(root)" ? f.name : `${parentPath}/${f.name}`;
          toVisit.push(f.id);
        } else {
          allFiles.push({ folder: folderPaths[folderId] || "(root)", name: f.name, id: f.id });
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
  }
  console.log(`\nTotal: ${allFiles.length} files\n`);
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });
