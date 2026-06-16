// build-chiller-ids.js
// Run once (or after adding new chiller datasheets to Drive):
//   node build-chiller-ids.js
//
// Scans the Drive folder, matches every APCY-E / APCY-H model to its
// datasheet file, and writes chiller-drive-ids.json.
// server.js loads that file at startup so button taps go straight to the
// file without calling listFolderFiles().

'use strict';
require('dotenv').config();
const { google }  = require('googleapis');
const fs          = require('fs');
const path        = require('path');
const { MODELS, SERIES } = require('./chillers.js');
const { DATASHEET_FOLDERS } = require('./catalogue-map.js');

const OUT = path.join(__dirname, 'chiller-drive-ids.json');

const DRIVE_FOLDER_ID          = process.env.DRIVE_FOLDER_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

function parseServiceAccount() {
  // Try the JSON file in the project root first (works locally without .env issues)
  const jsonFile = path.join(__dirname, 'whatsapp-bot-498411-c3f0589ba5aa.json');
  if (fs.existsSync(jsonFile)) return JSON.parse(fs.readFileSync(jsonFile, 'utf8'));

  // Fallback: env var (deployed / Render)
  const raw = (GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) throw new Error('No service account credentials found');
  const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const creds = JSON.parse(text.replace(/\\"/g, '"'));
  if (creds.private_key && creds.private_key.includes('\\n')) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }
  return creds;
}

async function listAllFiles() {
  const credentials = parseServiceAccount();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const drive = google.drive({ version: 'v3', auth: await auth.getClient() });

  const folderPaths = { [DRIVE_FOLDER_ID]: '(root)' };
  const toVisit = [DRIVE_FOLDER_ID];
  const collected = [];

  while (toVisit.length) {
    const folderId = toVisit.shift();
    let pageToken;
    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: 100,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of res.data.files || []) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          const parentPath = folderPaths[folderId] || '(root)';
          folderPaths[f.id] = parentPath === '(root)' ? f.name : `${parentPath}/${f.name}`;
          toVisit.push(f.id);
        } else if (f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.name)) {
          collected.push({ id: f.id, name: f.name, folder: folderPaths[folderId] || '(root)' });
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }
  return collected;
}

function findChillerFiles(series, code, files) {
  const aliases = DATASHEET_FOLDERS[series] || [];
  const out = [];
  for (const f of files) {
    const segs = (f.folder || '').toLowerCase().split('/').map(s => s.trim());
    if (!segs.some(s => aliases.includes(s))) continue;
    const norm = f.name.toLowerCase().replace(/[\s\-_.]/g, '');
    if (norm.includes(code)) out.push(f);
  }
  return out;
}

async function main() {
  if (!DRIVE_FOLDER_ID) { console.error('❌ DRIVE_FOLDER_ID not set'); process.exit(1); }

  console.log('🔍 Listing Drive files…');
  const files = await listAllFiles();
  console.log(`   Found ${files.length} PDF(s)`);

  const map = {};
  let matched = 0, missing = 0;

  for (const series of SERIES) {
    const models = MODELS.filter(m => m.series === series);
    for (const m of models) {
      const hits = findChillerFiles(series, m.code, files);
      const key = `${m.code}|${series}`;
      if (hits.length >= 1) {
        map[key] = { id: hits[0].id, name: hits[0].name };
        matched++;
        console.log(`   ✅ ${key} → ${hits[0].name}`);
      } else {
        missing++;
        console.log(`   ⚠️  ${key} — no file found`);
      }
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(map, null, 2));
  console.log(`\n✅ Wrote ${OUT}  (${matched} matched, ${missing} missing)`);
}

main().catch(e => { console.error(e); process.exit(1); });
