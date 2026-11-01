// Preloaded (node -r) into a child that runs the real server.js, by the idle test in
// tests/app-config.test.js. It does two things:
//   1. counts every way the process could call out: net/tls connects, http(s)
//      requests, fetch and DNS lookups;
//   2. records every timer the app sets, so the test can fire them all by hand.
// When the parent sends {cmd: "idle"} the startup counts are frozen, the clock is
// moved a day ahead, every interval and still-pending timeout is fired, and the
// calls made from that moment on are sent back. Nothing here changes what the
// app does; the real timers and sockets still run.
const net = require("net");
const tls = require("tls");
const http = require("http");
const https = require("https");
const dns = require("dns");

const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;
const realNow = Date.now;

let phase = "startup";
const calls = { startup: [], idle: [] };
const note = (what, detail) => {
  const stack = (new Error().stack || "").split("\n").slice(3).filter((l) => !l.includes("idle-hook.js") && !l.includes("node:internal")).slice(0, 3).map((l) => l.trim());
  calls[phase].push({ what, detail: String(detail).slice(0, 80), stack });
};

// ---- network counting (hooks wrap the originals, so startup behaves as normal) ----
function wrap(obj, name, label) {
  const orig = obj[name];
  if (typeof orig !== "function") return;
  obj[name] = function (...args) {
    const a = args[0];
    note(label, typeof a === "string" ? a : (a && (a.host || a.hostname || a.href || a.port)) || "");
    return orig.apply(this, args);
  };
}
wrap(net, "connect", "net.connect");
wrap(net, "createConnection", "net.createConnection");
wrap(net.Socket.prototype, "connect", "Socket.connect");
wrap(tls, "connect", "tls.connect");
wrap(http, "request", "http.request");
wrap(http, "get", "http.get");
wrap(https, "request", "https.request");
wrap(https, "get", "https.get");
wrap(dns, "lookup", "dns.lookup");
wrap(dns, "resolve", "dns.resolve");
wrap(dns.promises, "lookup", "dns.promises.lookup");
wrap(global, "fetch", "fetch");

// ---- timer recording ----
const timers = new Set();
function record(kind, orig, fn, ms, args) {
  const t = { kind, ms: Number(ms) || 0, fn, args, unref: false, done: false, created: phase };
  const handle = orig(function () { if (kind === "timeout") t.done = true; return fn.apply(this, arguments); }, ms, ...args);
  const realUnref = handle && handle.unref;
  if (realUnref) handle.unref = function () { t.unref = true; return realUnref.apply(this, arguments); };
  t.handle = handle;
  timers.add(t);
  return handle;
}
global.setTimeout = function (fn, ms, ...args) { return record("timeout", realSetTimeout, fn, ms, args); };
global.setInterval = function (fn, ms, ...args) { return record("interval", realSetInterval, fn, ms, args); };
global.clearTimeout = function (h) { for (const t of timers) if (t.handle === h) t.done = true; return realClearTimeout(h); };
global.clearInterval = function (h) { for (const t of timers) if (t.handle === h) t.done = true; return realClearInterval(h); };

// Test-only: stands in for a timer that calls out, so the test can prove it would be caught.
if (process.env.IDLE_TEST_ROGUE) global.setInterval(() => { global.fetch("http://example.invalid/").catch(() => {}); }, 60 * 60 * 1000).unref();

process.on("message", (m) => {
  if (!m || m.cmd !== "idle") return;
  const startup = calls.startup.length;
  const live = [...timers].filter((t) => !t.done);
  const report = {
    startupCalls: startup,
    // what is still scheduled at this moment, before anything is fired
    active: live.map((t) => ({ kind: t.kind, ms: t.ms, unref: t.unref, name: (t.fn && t.fn.name) || "" })),
  };
  phase = "idle";
  const offset = 25 * 3600 * 1000; // a day passes: every sweep and expiry is due
  Date.now = () => realNow() + offset;
  for (let round = 0; round < 3; round++) {
    for (const t of live.filter((x) => x.kind === "interval" || !x.done)) {
      try { Promise.resolve(t.fn.apply(null, t.args)).catch(() => {}); } catch (_) { /* a timer that throws is not a network call */ }
    }
  }
  realSetTimeout(() => {
    Date.now = realNow;
    report.idleCalls = calls.idle;
    report.fired = live.length * 3;
    process.send(report);
  }, 500);
});
