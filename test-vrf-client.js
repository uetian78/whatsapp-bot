// test-vrf-client.js — verifies sidecar readiness-gate + retry behavior with a
// mocked fetch (no live service needed). Run: node test-vrf-client.js
'use strict';
process.env.VRF_SIDECAR_URL = 'https://sidecar.test';
process.env.VRF_API_KEY = 'test-key';

let failures = 0;
const ok = (l, c) => { console.log((c ? '  ✅ ' : '  ❌ ') + l); if (!c) failures++; };

function mockResponse(status, { json, buf, headers } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (headers || {})[k.toLowerCase()] },
    json: async () => json || {},
    arrayBuffer: async () => buf || new ArrayBuffer(0),
  };
}
const isHealth = (url) => String(url).endsWith('/health');

const { runVrfSelection, warmUpSidecar, waitForSidecarReady } = require('./vrf/vrfClient');
const input = { project: 'P', rows: [{ type: 'cassette', required_kw: 5, qty: 1, system: 'S1', room: 'R' }] };

(async () => {
  // 1) health 200, then /select 502 then 200 -> gate passes, POST retries, succeeds
  let health = 0, select = 0;
  global.fetch = async (url) => {
    if (isHealth(url)) { health++; return mockResponse(200, { json: { ok: true } }); }
    select++;
    if (select === 1) return mockResponse(502);
    return mockResponse(200, {
      buf: Buffer.from('PK\x03\x04 fake').buffer,
      headers: { 'x-summary': JSON.stringify({ project: 'P', systems: 1 }) },
    });
  };
  console.log('Test 1: health OK, /select 502→200 (gate passes, POST retries)');
  const t0 = Date.now();
  const r = await runVrfSelection(input);
  ok('returned a Buffer', Buffer.isBuffer(r.xlsxBuffer));
  ok('summary parsed', r.summary && r.summary.project === 'P');
  ok('polled /health before POST', health >= 1);
  ok('POSTed /select twice (1 retry)', select === 2);
  console.log(`     (~${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 2) health 200, /select 400 -> immediate throw, no retry
  health = 0; select = 0;
  global.fetch = async (url) => {
    if (isHealth(url)) return mockResponse(200, { json: { ok: true } });
    select++; return mockResponse(400, { json: { error: 'bad rows' } });
  };
  console.log('Test 2: /select 400 — immediate throw, no retry');
  let threw = null;
  try { await runVrfSelection(input); } catch (e) { threw = e; }
  ok('threw on 400', !!threw);
  ok('message includes "sidecar 400"', threw && /sidecar 400/.test(threw.message));
  ok('did NOT retry /select (1 call)', select === 1);

  // 3) waitForSidecarReady: 200 -> true fast
  global.fetch = async () => mockResponse(200, { json: { ok: true } });
  console.log('Test 3: waitForSidecarReady resolves true on 200');
  ok('ready=true', (await waitForSidecarReady(5000)) === true);

  // 4) waitForSidecarReady: never healthy within a tiny budget -> false (no throw)
  global.fetch = async () => { throw new Error('cold/booting'); };
  console.log('Test 4: waitForSidecarReady gives up false within budget');
  const t1 = Date.now();
  const res4 = await waitForSidecarReady(50);
  ok('ready=false', res4 === false);
  ok('returned promptly (<6s)', Date.now() - t1 < 6000);

  // 5) waitForSidecarReady heartbeats onProgress while waiting
  global.fetch = async () => { throw new Error('cold/booting'); };
  console.log('Test 5: onProgress heartbeat fires while waiting');
  let beats = 0;
  await waitForSidecarReady(260, () => { beats++; }, 80); // ~3 beats in 260ms
  ok('onProgress called at least once', beats >= 1);

  // 6) warmUpSidecar never throws even if fetch rejects
  global.fetch = async () => { throw new Error('network down'); };
  console.log('Test 6: warmUpSidecar swallows errors');
  let warmThrew = null;
  try { await warmUpSidecar(); } catch (e) { warmThrew = e; }
  ok('warmUpSidecar did not throw', warmThrew === null);

  console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ All vrfClient checks passed');
  process.exit(failures ? 1 : 0);
})();
