// test-chillers.js — exercises the chiller knowledge base + WhatsApp routing.
// Run: node test-chillers.js   (expects zero thrown errors)
'use strict';

const C = require('./chillers.js');

let failures = 0;
const line = (s = '') => console.log(s);
const hr = () => line('─'.repeat(60));

function check(label, cond) {
  if (!cond) { failures++; line(`   ❌ ASSERT FAILED: ${label}`); }
}

// ── findByModel ───────────────────────────────────────────────
hr(); line('findByModel');
for (const q of ['APCY5530TH', '5530TH', '5530 H', 'apcy5285de', '5285']) {
  const r = C.findByModel(q);
  if (Array.isArray(r)) {
    line(`  "${q}" -> AMBIGUOUS: ${r.map(m => m.model).join(', ')}`);
    check(`${q} ambiguous has hits`, r.length > 1);
  } else if (r) {
    line(`  "${q}" -> ${r.model} (${r.capacityTR} TR, EER ${r.eer})`);
  } else {
    line(`  "${q}" -> not found`);
    check(`${q} resolves`, false);
  }
}

// ── selectByTonnage for 250 / 400 / 600 TR in each series ─────
hr(); line('selectByTonnage (250 / 400 / 600 TR per series)');
for (const series of C.SERIES) {
  for (const tr of [250, 400, 600]) {
    const list = C.selectByTonnage(tr, series);
    const desc = list.map(m => `${m.model}=${m.capacityTR}TR${m._overRange ? ' (OVER-RANGE)' : ''}`).join('  +  ');
    line(`  ${series} @ ${tr} TR -> ${desc}`);
    check(`${series} ${tr} returns at least 1`, list.length >= 1);
    if (!list[0]._overRange) {
      const top = list[list.length - 1];
      check(`${series} ${tr} top meets load`, top.capacityTR >= tr);
    }
  }
}

// ── compare two models ────────────────────────────────────────
hr(); line("compare('APCY5285DE', 'APCY5285DH')");
const cmp = C.compare('APCY5285DE', 'APCY5285DH');
check('compare returns object', !!cmp);
if (cmp) {
  line(`  deltas: ${JSON.stringify(cmp.deltas)}`);
  line('  --- formatted (fmtCompare) ---');
  line(C.fmtCompare('APCY5285DE', 'APCY5285DH').split('\n').map(l => '  ' + l).join('\n'));
}

// ── series compare ────────────────────────────────────────────
hr(); line('fmtSeriesCompare');
line(C.fmtSeriesCompare().split('\n').map(l => '  ' + l).join('\n'));

// ── datasheetFileName ─────────────────────────────────────────
hr(); line('datasheetFileName');
for (const q of ['APCY5530TH', 'APCY5285DE']) {
  const m = C.findByModel(q);
  if (m && !Array.isArray(m)) line(`  ${m.model} -> ${C.datasheetFileName(m)}`);
}

// ── routeChillerText: every intent a-e + the guard ───────────
hr(); line('routeChillerText (intent routing)');
const cases = [
  'APCY5530TH',                 // a: model lookup
  'tell me about 5285DE',       // a: model lookup (NL)
  '5285',                       // a: bare code in BOTH series -> disambiguate
  '400 TR chiller',             // b: tonnage, no series -> series buttons
  'chiller 300TR H',            // b: tonnage, series H
  'APCY5530TH datasheet',       // c: datasheet
  '5530th spec sheet',          // c: datasheet
  'compare APCY-E and APCY-H',  // d: series compare
  'difference between E and H series', // d: series compare (NL)
  'compare 5285DE and 5285DH',  // e: two-model compare
  'APCY-H',                     // guard: bare series -> null (catalogue flow)
  'package unit 20 tr t3',      // guard: APMR selection -> null
  '52300 datasheet',            // guard: APMR datasheet -> null
];
for (const msg of cases) {
  const r = C.routeChillerText(msg);
  if (!r) { line(`  "${msg}" -> null (passes through)`); continue; }
  const summary = r.type === 'buttons'
    ? `buttons[${r.buttons.map(b => b.id).join(', ')}]`
    : r.type === 'datasheet'
      ? `datasheet ${r.series} ${r.code}`
      : `text(${r.text.split('\n')[0]}…)`;
  line(`  "${msg}" -> ${r.type}: ${summary}`);
}
// Specific guards
check('"APCY-H" passes through (null)', C.routeChillerText('APCY-H') === null);
check('"package unit 20 tr t3" passes through (null)', C.routeChillerText('package unit 20 tr t3') === null);
check('"400 TR chiller" -> buttons', C.routeChillerText('400 TR chiller').type === 'buttons');
check('"APCY5530TH datasheet" -> datasheet', C.routeChillerText('APCY5530TH datasheet').type === 'datasheet');
check('"5285" -> disambiguation buttons', C.routeChillerText('5285').type === 'buttons');

// ── handleChillerButton round-trips ──────────────────────────
hr(); line('handleChillerButton');
for (const id of ['chmodel|5285|APCY-H', 'chsel|400|APCY-E', 'chds|5530|APCY-H']) {
  const r = C.handleChillerButton(id);
  check(`button ${id} handled`, !!r);
  line(`  "${id}" -> ${r ? r.type : 'null'}`);
}

// ── button title length guard (WhatsApp <=20) ────────────────
hr(); line('button title lengths (must be <= 20)');
const btnMsgs = ['5285', '400 TR chiller', 'APCY5530TH', '5285 datasheet'];
for (const msg of btnMsgs) {
  const r = C.routeChillerText(msg);
  if (r && r.buttons) for (const b of r.buttons) {
    const len = [...b.title].length;
    check(`title "${b.title}" <= 20`, len <= 20);
    line(`  "${b.title}" (${len})`);
  }
}

hr();
if (failures) { line(`\n❌ ${failures} assertion(s) failed.`); process.exit(1); }
line('\n✅ All checks passed — zero errors.');
