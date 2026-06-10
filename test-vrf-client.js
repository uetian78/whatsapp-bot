// test-vrf-client.js — verifies sidecar retry + warm-up behavior with a mocked
// fetch (no live service needed). Run: node test-vrf-client.js
'use strict';
process.env.VRF_SIDECAR_URL = 'https://sidecar.test';
process.env.VRF_API_KEY = 'test-key';

let failures = 0;
const ok = (label, cond) => { console.log((cond ? '  ✅ ' : '  ❌ ') + label); if (!cond) failures++; };

function mockResponse(status, { json, buf, headers } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (headers || {})[k.toLowerCase()] },
    json: async () => json || {},
    arrayBuffer: async () => buf || new ArrayBuffer(0),
  };
}

const { runVrfSelection, warmUpSidecar } = require('./vrf/vrfClient');
const input = { project: 'P', rows: [{ type: 'cassette', required_kw: 5, qty: 1, system: 'S1', room: 'R' }] };

(async () => {
  // 1) 502 then 200 -> retries, then succeeds
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return mockResponse(502);
    return mockResponse(200, {
      buf: Buffer.from('PK\x03\x04 fake-xlsx').buffer,
      headers: { 'x-summary': JSON.stringify({ project: 'P', systems: 1 }) },
    });
  };
  console.log('Test 1: 502 then 200 — expect retry then success');
  const t0 = Date.now();
  const r = await runVrfSelection(input);
  ok('returned a Buffer', Buffer.isBuffer(r.xlsxBuffer));
  ok('summary parsed from X-Summary header', r.summary && r.summary.project === 'P');
  ok('made exactly 2 fetch calls (1 retry)', calls === 2);
  console.log(`     (waited ~${((Date.now() - t0) / 1000).toFixed(1)}s backoff)`);

  // 2) 400 -> immediate throw, NO retry (real engine/auth errors must not loop)
  calls = 0;
  global.fetch = async () => { calls++; return mockResponse(400, { json: { error: 'bad rows' } }); };
  console.log('Test 2: 400 — expect immediate throw, no retry');
  let threw = null;
  try { await runVrfSelection(input); } catch (e) { threw = e; }
  ok('threw on 400', !!threw);
  ok('message includes "sidecar 400"', threw && /sidecar 400/.test(threw.message));
  ok('did NOT retry (exactly 1 call)', calls === 1);

  // 3) warmUpSidecar must never throw, even when the network is down
  global.fetch = async () => { throw new Error('network down'); };
  console.log('Test 3: warmUpSidecar swallows errors');
  let warmThrew = null;
  try { await warmUpSidecar(); } catch (e) { warmThrew = e; }
  ok('warmUpSidecar did not throw', warmThrew === null);

  console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ All vrfClient checks passed');
  process.exit(failures ? 1 : 0);
})();
