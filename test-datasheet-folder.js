// test-datasheet-folder.js — verifies datasheet lookup works for nested folders
// (e.g. "Datasheets/APMR Selections") and that "APMR 52340 T1" parses correctly.
// Run: node test-datasheet-folder.js
'use strict';
const { datasheetFolderForSeries, datasheetCondition } = require('./catalogue-map.js');
const { parseDatasheetRequest } = require('./products.js');

let failures = 0;
const ok = (l, c) => { console.log((c ? '  ✅ ' : '  ❌ ') + l); if (!c) failures++; };

// Mirror server.js findDatasheetFiles() exactly, to prove the real matcher works.
function findDatasheetFiles(series, code, files) {
  const out = [];
  for (const f of files) {
    if (!datasheetFolderForSeries(f.folder, series)) continue;
    if (!new RegExp(`\\b${code}\\b`).test(f.name)) continue;
    out.push({ name: f.name, id: f.id, condition: datasheetCondition(f.name) });
  }
  return out;
}

console.log('datasheetFolderForSeries (segment match)');
ok('nested "Datasheets/APMR Selections" -> APMR', datasheetFolderForSeries('Datasheets/APMR Selections', 'APMR') === true);
ok('flat "APMR Selections" -> APMR',              datasheetFolderForSeries('APMR Selections', 'APMR') === true);
ok('APMR folder does NOT match APMR-A',           datasheetFolderForSeries('Datasheets/APMR Selections', 'APMR-A') === false);
ok('nested APMR-A folder -> APMR-A',              datasheetFolderForSeries('Datasheets/APMR-A Selections', 'APMR-A') === true);
ok('APMR-A folder does NOT match APMR',           datasheetFolderForSeries('Datasheets/APMR-A Selections', 'APMR') === false);
ok('nested PAC4A folder -> PAC4A',                datasheetFolderForSeries('Datasheets/PAC4A Selections', 'PAC4A') === true);

console.log('parseDatasheetRequest("APMR 52340 T1") — with space after APMR');
const r = parseDatasheetRequest('APMR 52340 T1');
ok('parsed', !!r);
ok('series APMR', r && r.series === 'APMR');
ok('code 52340', r && r.code === '52340');
ok('condition T1', r && r.condition === 'T1');
ok('explicit (has T1)', r && r.explicit === true);

console.log('parseDatasheetRequest("APMRa 51004") — bare series+code, no "datasheet" word');
const r2 = parseDatasheetRequest('APMRa 51004');
ok('parsed (now routes to datasheet)', !!r2);
ok('series APMR-A', r2 && r2.series === 'APMR-A');
ok('code 51004', r2 && r2.code === '51004');
ok('no condition', r2 && r2.condition === null);
ok('implicit (explicit=false)', r2 && r2.explicit === false);

console.log('parseDatasheetRequest("APMR 52340 datasheet") — explicit word');
const r3 = parseDatasheetRequest('APMR 52340 datasheet');
ok('explicit=true', r3 && r3.explicit === true);

console.log('parseDatasheetRequest("APMR 20 tr") — selection, not a datasheet');
ok('null (no 5-digit code)', parseDatasheetRequest('APMR 20 tr') === null);

console.log('findDatasheetFiles for APMR-A 51004 (nested folder)');
const aFiles = [
  { name: 'APMRA 51004 A - T1.pdf', id: 'a1', folder: 'Datasheets/APMR-A Selections' },
  { name: 'APMRA 51004 A - T3.pdf', id: 'a3', folder: 'Datasheets/APMR-A Selections' },
];
const aMatches = findDatasheetFiles('APMR-A', '51004', aFiles);
ok('finds both APMR-A 51004 files', aMatches.length === 2);
ok('conditions T1+T3', aMatches.some(m => m.condition === 'T1') && aMatches.some(m => m.condition === 'T3'));

console.log('findDatasheetFiles against the real Drive layout');
const files = [
  { name: 'APMR 52340 - T1.pdf', id: 't1', folder: 'Datasheets/APMR Selections' },
  { name: 'APMR 52340 - T3.pdf', id: 't3', folder: 'Datasheets/APMR Selections' },
  { name: 'APMR 52300 - T1.pdf', id: 'x',  folder: 'Datasheets/APMR Selections' },
];
const matches = findDatasheetFiles('APMR', '52340', files);
ok('finds both 52340 files', matches.length === 2);
ok('T1 present', matches.some((m) => m.condition === 'T1'));
ok('T3 present', matches.some((m) => m.condition === 'T3'));
ok('does not grab 52300', !matches.some((m) => m.id === 'x'));

console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ All datasheet-folder checks passed');
process.exit(failures ? 1 : 0);
