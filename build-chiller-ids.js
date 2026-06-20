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
const fs          = require('fs');
const path        = require('path');
const { MODELS, SERIES } = require('./chillers.js');
const { DATASHEET_FOLDERS } = require('./catalogue-map.js');
const { listAllFiles } = require('./lib/drive-scan.js');

const OUT = path.join(__dirname, 'chiller-drive-ids.json');

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

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
