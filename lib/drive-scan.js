// lib/drive-scan.js
// Shared Drive access: credential loading + recursive PDF listing.
// Used by build-chiller-ids.js and build-product-ids.js.
'use strict';
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

function parseServiceAccount() {
  // Try the JSON file in the project root first (works locally without .env issues)
  const jsonFile = path.join(__dirname, '..', 'whatsapp-bot-498411-c3f0589ba5aa.json');
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
  if (!DRIVE_FOLDER_ID) throw new Error('DRIVE_FOLDER_ID not set');
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

module.exports = { listAllFiles, parseServiceAccount };
