// build-product-ids.js
// Run once (or after adding new catalogue/IOM PDFs to Drive, or new entries
// to catalogue-map.js):
//   node build-product-ids.js
//
// Resolves every CATALOGUE_MAP series' exact catalogue/IOM filename to its
// Drive file ID and writes product-drive-ids.json. server.js loads that file
// at startup so catalogue/IOM requests skip listFolderFiles() on a cache hit.
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { listAllFiles } = require('./lib/drive-scan.js');
const { CATALOGUE_MAP, folderToDocType } = require('./catalogue-map.js');

const OUT = path.join(__dirname, 'product-drive-ids.json');

function leafFolder(p) {
  const segs = (p || '').split('/');
  return segs[segs.length - 1] || '';
}

async function main() {
  console.log('Listing Drive files...');
  const files = await listAllFiles();
  console.log(`Found ${files.length} PDF(s)`);

  const catalogueFiles = files.filter((f) => folderToDocType(leafFolder(f.folder)) === 'Catalogue');
  const iomFiles = files.filter((f) => folderToDocType(leafFolder(f.folder)) === 'IOM');
  const byName = {
    Catalogue: new Map(catalogueFiles.map((f) => [f.name.trim().toLowerCase(), f])),
    IOM: new Map(iomFiles.map((f) => [f.name.trim().toLowerCase(), f])),
  };

  const map = {};
  let matched = 0, missing = 0, skipped = 0;

  for (const entry of CATALOGUE_MAP) {
    for (const docType of ['Catalogue', 'IOM']) {
      const exact = docType === 'Catalogue' ? entry.catalogue : entry.iom;
      if (!exact) { skipped++; continue; } // entry has no file of this type on file — not an error
      const hit = byName[docType].get(exact.trim().toLowerCase());
      const key = `${entry.name}|${docType}`;
      if (hit) {
        map[key] = { id: hit.id, name: hit.name };
        matched++;
        console.log(`  ✅ ${key} -> ${hit.name}`);
      } else {
        missing++;
        console.log(`  ⚠️  ${key} expected "${exact}" — not found in Drive`);
      }
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(map, null, 2));
  console.log(`\n✅ Wrote ${OUT}  (${matched} matched, ${missing} missing, ${skipped} skipped-no-file-on-record)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
