// One-time script: adds " - IOM" suffix to every file in the IOM folder.
// Usage:  node rename-iom.js path/to/service-account.json
// The JSON file is the one downloaded from Google Cloud -> Service Accounts -> Keys.

const fs = require("fs");
const { google } = require("googleapis");

const IOM_FOLDER_ID = "1-0SHpiLTe7-kmnejRzhiRV-9lSfrybBH";

async function main() {
  const keyFile = process.argv[2];
  if (!keyFile) {
    console.error("Usage: node rename-iom.js path/to/service-account.json");
    process.exit(1);
  }
  if (!fs.existsSync(keyFile)) {
    console.error(`File not found: ${keyFile}`);
    process.exit(1);
  }

  const creds = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  const drive = google.drive({ version: "v3", auth });

  // List all files in the IOM folder
  const res = await drive.files.list({
    q: `'${IOM_FOLDER_ID}' in parents and trashed = false`,
    fields: "files(id, name)",
    pageSize: 100,
  });

  const files = res.data.files;
  if (!files.length) {
    console.log("No files found.");
    return;
  }

  console.log(`Found ${files.length} files. Renaming...\n`);

  for (const file of files) {
    const oldName = file.name;
    const base = oldName.endsWith(".pdf") ? oldName.slice(0, -4).trimEnd() : oldName.trimEnd();
    const newName = `${base}_catalogue.pdf`;

    if (oldName === newName) {
      console.log(`SKIP  ${oldName} (already correct)`);
      continue;
    }

    await drive.files.update({
      fileId: file.id,
      requestBody: { name: newName },
    });
    console.log(`OK    ${oldName}  →  ${newName}`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
