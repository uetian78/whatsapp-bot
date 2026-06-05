const { google } = require("googleapis");
const fs = require("fs");

async function main() {
  const creds = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/drive"] });
  const drive = google.drive({ version: "v3", auth });

  await drive.files.update({ fileId: "171bG7neA-aJdSifc9wekRRRlB5u92vSY", requestBody: { name: "HVACBOT" } });
  console.log("OK    Catalogue → HVACBOT");
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });
