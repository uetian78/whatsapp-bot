// test-vrf-units.js — verifies TR/kW (and other unit) handling in VRF intake.
// Run: node test-vrf-units.js
'use strict';
const XLSX = require('xlsx');
const { capacityToKw, rowsFromWorkbook, guidedStep, startGuided, extractionConfirmText } = require('./vrf/vrfIntake');

let failures = 0;
const approx = (a, b, t = 0.02) => Math.abs(a - b) <= t;
const ok = (l, c) => { console.log((c ? '  ✅ ' : '  ❌ ') + l); if (!c) failures++; };

console.log('capacityToKw');
ok('2 TR -> ~7.03 kW',   approx(capacityToKw(2, 'TR').kw, 7.03));
ok('2 ton -> ~7.03 kW',  approx(capacityToKw(2, 'ton').kw, 7.03));
ok('5 kW -> 5',          capacityToKw(5, 'kW').kw === 5);
ok('5 (no unit) -> kW',  capacityToKw(5, '').kw === 5 && capacityToKw(5, '').unit === 'kW');
ok('12000 BTU/h -> ~3.52', approx(capacityToKw(12000, 'BTU/h').kw, 3.52, 0.05));
ok('60 MBH -> ~17.58',   approx(capacityToKw(60, 'MBH').kw, 17.58, 0.05));
ok('unit label TR kept', capacityToKw(2, 'TR').unit === 'TR');

console.log('manual entry "2 TR" (guided flow)');
const s = startGuided();
guidedStep(s, 'My Project');                         // project stage
guidedStep(s, '4 way cassette | 2 TR | 1 | S1 | Office'); // rows stage
ok('row added', s.rows.length === 1);
ok('2 TR converted to ~7.03 kW', approx(s.rows[0].required_kw, 7.03));
ok('plain "7" stays kW', (() => { guidedStep(s, 'duct | 7 | 2 | S1 | Lab'); return s.rows[1].required_kw === 7; })());

console.log('xlsx with a "Capacity (TR)" column');
const aoa = [
  ['Tag', 'Type', 'Capacity (TR)', 'Qty', 'System', 'Room'],
  ['IU1', '4 way cassette', 2, 1, 'S1', 'Office'],
  ['IU2', 'duct', 3, 2, 'S1', 'Lab'],
];
const ws = XLSX.utils.aoa_to_sheet(aoa);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'S');
const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
const rows = rowsFromWorkbook(buf);
ok('2 rows parsed', rows.length === 2);
ok('2 TR -> ~7.03 kW',  approx(rows[0].required_kw, 7.03));
ok('3 TR -> ~10.55 kW', approx(rows[1].required_kw, 10.55));
ok('src unit TR retained', rows[0]._srcUnit === 'TR');

console.log('confirmation text shows the conversion');
const txt = extractionConfirmText(rows);
ok('shows "2 TR -> ... kW"', /2 TR →/.test(txt));

console.log('regression: a kW xlsx still reads as kW (no false conversion)');
const aoaKw = [['Type', 'Cooling Load (kW)', 'Qty'], ['cassette', 5.6, 1]];
const wsk = XLSX.utils.aoa_to_sheet(aoaKw);
const wbk = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wbk, wsk, 'S');
const rowsKw = rowsFromWorkbook(XLSX.write(wbk, { type: 'buffer', bookType: 'xlsx' }));
ok('5.6 kW stays 5.6', approx(rowsKw[0].required_kw, 5.6) && rowsKw[0]._srcUnit === 'kW');

console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ All unit checks passed');
process.exit(failures ? 1 : 0);
