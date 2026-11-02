// Preloaded (node -r) into a child that runs the real server.js, by the idle test in
// tests/app-config.test.js. It does two things:
//   1. counts every way the process could call out: net/tls connects, http(s)
//      requests, fetch and DNS lookups;
//   2. records every timer the app sets, so the test can fire them all by hand.
// When the parent sends {cmd: "idle"} the startup counts are frozen, the clock is
// moved a day ahead, every interval and still-pending timeout is fired, and the
// calls made from that moment on are sent back. Nothing here changes what the
// app does; the real timers and sockets still run.
//
// What it can and cannot see. A one-shot timeout is fired by hand at most once.
// A timer that a fired callback schedules in turn (an interval that sets a longer
// one-shot) IS seen and fired too: timers made while firing are picked up in the
// next round, for as long as rounds keep finding one-shots, up to MAX_ROUNDS. It
// is blind to anything that is not setTimeout/setInterval: setImmediate,
// process.nextTick, worker threads, native handles, and a timer that a callback
// only schedules after more than SETTLE_MS of its own awaiting. A call made over
// a path the hook does not wrap (the wrapped list is below) is not counted either.
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

// Test-only: stand in for a timer that calls out, so the test can prove each way of
// calling out would be caught. IDLE_TEST_ROGUE is "1" or "fetch" (an interval that
// fetches), "https" (an interval that makes an https.request) or "chained" (an
// interval that, when it fires, schedules a longer one-shot that fetches).
const rogue = process.env.IDLE_TEST_ROGUE;
const HOUR = 60 * 60 * 1000;
if (rogue === "1" || rogue === "fetch") {
  global.setInterval(() => { global.fetch("http://example.invalid/").catch(() => {}); }, HOUR).unref();
} else if (rogue === "https") {
  global.setInterval(() => {
    const req = https.request({ host: "example.invalid", path: "/", method: "GET" });
    req.on("error", () => {});
    req.end();
  }, HOUR).unref();
} else if (rogue === "chained") {
  // The first tick sets one longer one-shot, and only the first: if the check fired
  // one-shots in every round, that single timer would fetch several times.
  let armed = true;
  global.setInterval(() => {
    if (!armed) return;
    armed = false;
    global.setTimeout(() => { global.fetch("http://example.invalid/").catch(() => {}); }, 2 * HOUR).unref();
  }, HOUR).unref();
}

const SETTLE_MS = 250; // how long a fired callback's own async work may run before the next look for new timers
const MAX_ROUNDS = 10;
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

process.on("message", async (m) => {
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
  let fired = 0;
  const fire = (t) => {
    if (t.kind === "timeout") t.done = true; // a one-shot runs once, however many rounds follow
    fired += 1;
    try { Promise.resolve(t.fn.apply(null, t.args)).catch(() => {}); } catch (_) { /* a timer that throws is not a network call */ }
  };
  // Every round fires whatever is still pending: intervals each time (a day's worth of
  // ticks), one-shots the once. Timers made while firing are in the set by the next
  // round. At least three rounds, then on while one-shots keep turning up.
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const due = [...timers].filter((t) => !t.done);
    if (round > 3 && !due.some((t) => t.kind === "timeout")) break;
    for (const t of due) fire(t);
    await sleep(SETTLE_MS);
  }
  realSetTimeout(() => {
    Date.now = realNow;
    report.idleCalls = calls.idle;
    report.fired = fired;
    process.send(report);
  }, 500);
});
