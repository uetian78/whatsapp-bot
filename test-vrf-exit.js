// test-vrf-exit.js — verifies the user can always exit a VRF session, including
// after a build error (sidecar failure) leaves it open. Run: node test-vrf-exit.js
// NOTE: VRF_SIDECAR_URL is intentionally unset so finishAndSend() throws,
// simulating the sidecar-502 failure path.
'use strict';
delete process.env.VRF_SIDECAR_URL;
delete process.env.VRF_API_KEY;

const { initVrf, onVrfKeyword, onVrfMessage, sessions } = require('./vrf/vrfHandler');

const sent = [];
initVrf({ sendText: async (_u, t) => { sent.push(t); }, sendDocument: async () => {} });

let failures = 0;
const ok = (l, c) => { console.log((c ? '  ✅ ' : '  ❌ ') + l); if (!c) failures++; };
const last = () => sent[sent.length - 1] || '';
const U = 'user-1';

(async () => {
  // 1) exit from a fresh session
  console.log('Test 1: exit from a fresh session');
  await onVrfKeyword(U);
  ok('session created', sessions.has(U));
  await onVrfMessage(U, 'exit');
  ok('exit deletes the session', !sessions.has(U));
  ok('confirms cancellation', /cancel/i.test(last()));

  // 2) build error keeps the session, then exit works (the reported bug)
  console.log('Test 2: build fails (sidecar), session stays, then exit');
  await onVrfKeyword(U);
  sessions.get(U).pending = {
    project: 'P', discount: undefined,
    rows: [{ type: 'duct', required_kw: 7, qty: 1, system: 'S1', room: '' }],
  };
  await onVrfMessage(U, 'yes'); // finishAndSend -> runVrfSelection throws (no sidecar)
  ok('session still alive after error', sessions.has(U));
  ok('error offers retry/exit', /exit/i.test(last()));
  ok('pending preserved for retry', !!sessions.get(U).pending);
  await onVrfMessage(U, 'cancel'); // the word the user said they tried
  ok('"cancel" exits after the error', !sessions.has(U));

  // 3) exit works while awaiting yes/no confirmation
  console.log('Test 3: exit while pending confirmation');
  await onVrfKeyword(U);
  sessions.get(U).pending = { project: 'P', rows: [{ type: 'duct', required_kw: 7, qty: 1 }] };
  await onVrfMessage(U, 'exit');
  ok('exit works while pending', !sessions.has(U));

  // 4) "stop"/"quit" also exit
  console.log('Test 4: stop / quit aliases');
  await onVrfKeyword(U);
  await onVrfMessage(U, 'STOP');
  ok('"STOP" (any case) exits', !sessions.has(U));

  console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ All exit checks passed');
  process.exit(failures ? 1 : 0);
})();
