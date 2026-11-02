const test = require("node:test");
const assert = require("node:assert");
const { whatsappEnabled, requiredEnv } = require("../lib/app-config.js");

test("WhatsApp is on only when WHATSAPP_ENABLED is exactly true", () => {
  assert.equal(whatsappEnabled({ WHATSAPP_TOKEN: "x" }), false);
  assert.equal(whatsappEnabled({ WHATSAPP_ENABLED: "true" }), true);
  for (const v of ["TRUE", "True", "1", "yes", "false", "", " true"]) {
    assert.equal(whatsappEnabled({ WHATSAPP_ENABLED: v }), false, JSON.stringify(v));
  }
});

test("required env without WhatsApp", () => {
  assert.deepEqual(requiredEnv({}), ["GOOGLE_SHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON"]);
});

test("required env with WhatsApp adds its three settings", () => {
  assert.deepEqual(requiredEnv({ WHATSAPP_ENABLED: "true" }), [
    "GOOGLE_SHEET_ID", "GOOGLE_SERVICE_ACCOUNT_JSON",
    "VERIFY_TOKEN", "WHATSAPP_TOKEN", "PHONE_NUMBER_ID",
  ]);
});

// ---- startup warnings: data loss and dead share links must not be silent ----
const { startupWarnings } = require("../lib/app-config.js");
const { dataDir } = require("../lib/db.js");

test("DATA_DIR wins, then the Railway volume mount, then the home folder", () => {
  assert.equal(dataDir({ DATA_DIR: "/d", RAILWAY_VOLUME_MOUNT_PATH: "/data" }), "/d");
  assert.equal(dataDir({ RAILWAY_VOLUME_MOUNT_PATH: "/data" }), "/data");
  assert.equal(dataDir({ DATA_DIR: "", RAILWAY_VOLUME_MOUNT_PATH: "/data" }), "/data");
  assert.match(dataDir({}), /\.hvac-assistant$/);
});

test("a Railway deploy with no volume, or a data folder that isn't the volume, warns loudly", () => {
  const noVolume = startupWarnings({ RAILWAY_ENVIRONMENT: "production", DATA_DIR: "/data", PUBLIC_URL: "https://x" });
  assert.equal(noVolume.length, 1);
  assert.match(noVolume[0], /DATA LOSS.*no volume/);
  const elsewhere = startupWarnings({ RAILWAY_ENVIRONMENT: "production", DATA_DIR: "/app/data", RAILWAY_VOLUME_MOUNT_PATH: "/data", PUBLIC_URL: "https://x" });
  assert.equal(elsewhere.length, 1);
  assert.match(elsewhere[0], /DATA LOSS.*\/app\/data.*\/data/);
});

test("a Railway deploy whose data folder is the volume is quiet about data", () => {
  const w = startupWarnings({ RAILWAY_ENVIRONMENT: "production", DATA_DIR: "/data", RAILWAY_VOLUME_MOUNT_PATH: "/data", PUBLIC_URL: "https://x" });
  assert.deepEqual(w, []);
  const fallback = startupWarnings({ RAILWAY_ENVIRONMENT: "production", RAILWAY_VOLUME_MOUNT_PATH: "/data", PUBLIC_URL: "https://x" });
  assert.equal(fallback.length, 1);
  assert.match(fallback[0], /DATA_DIR is not set — using the Railway volume at \/data/);
  assert.doesNotMatch(fallback[0], /DATA LOSS/);
});

test("an unset DATA_DIR off Railway and an unset PUBLIC_URL are each warned about", () => {
  const w = startupWarnings({});
  assert.equal(w.length, 2);
  assert.ok(w.some((l) => /DATA_DIR is not set/.test(l)));
  assert.ok(w.some((l) => /PUBLIC_URL is not set.*503/.test(l)));
  assert.deepEqual(startupWarnings({ DATA_DIR: "/somewhere", PUBLIC_URL: "https://x" }), []);
});

// ---- the idle app makes no network calls, so Railway can put it to sleep ----
// Runs the real server.js (WhatsApp off, dummy settings) in a child with
// tests/idle-hook.js preloaded. Startup may call out (crm.warmUp reads the contacts
// sheet once); the test lets that settle, then moves the clock a day ahead, fires
// every interval and pending timer by hand, and counts the calls made from then on.
const { fork } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function runIdle(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-"));
  // cwd is empty so dotenv finds no .env: only the dummy settings below exist.
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, // enough for node to start
    GOOGLE_SHEET_ID: "dummy-sheet", GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    WEB_SECRET: "x".repeat(40), DATA_DIR: dir, PORT: "0",
    ...extraEnv,
  };
  const child = fork(path.join(__dirname, "..", "server.js"), [], {
    cwd: dir, env, execArgv: ["-r", path.join(__dirname, "idle-hook.js")], silent: true,
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return new Promise((resolve, reject) => {
    let sent = false;
    const kill = setTimeout(() => { child.kill(); reject(new Error("idle run timed out. Output so far:\n" + out)); }, 45000); // generous: the whole suite runs files in parallel and boot slows down
    let report = null;
    child.on("message", (r) => { clearTimeout(kill); report = r; child.kill(); });
    child.on("exit", (code) => {
      clearInterval(poll);
      if (report) {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch (_) { /* a temp dir left behind is harmless */ }
        return resolve(report);
      }
      clearTimeout(kill);
      reject(new Error(`server exited early (${code}):\n${out}`));
    });
    const poll = setInterval(() => {
      if (/Listening on/.test(out) && !sent) {
        sent = true; clearInterval(poll);
        setTimeout(() => child.send({ cmd: "idle" }), 1500); // let the startup calls finish first
      }
    }, 50);
  });
}

// Both runs start together so the file takes one boot of time, not two.
const idleRun = runIdle();
const rogueRun = runIdle({ IDLE_TEST_ROGUE: "1" });
idleRun.catch(() => {}); rogueRun.catch(() => {}); // reported by the tests below

test("with WhatsApp off, no timer makes a network call while idle", async (t) => {
  const r = await idleRun;
  t.diagnostic(`startup made ${r.startupCalls} network call(s) (allowed once at boot); timers active at idle: ${JSON.stringify(r.active)}`);
  assert.ok(r.active.length > 0, "the hook should see the app's timers");
  // A timer that is not unref'd would keep the process awake. Pending one-shot timeouts are
  // fine only if they are short-lived, so the app's long-running timers must all be unref'd.
  const awake = r.active.filter((x) => x.kind === "interval" && !x.unref);
  assert.deepEqual(awake, [], "every interval must be unref'd");
  assert.deepEqual(r.idleCalls, [], "no network call after startup, with every timer fired a day later");
});

test("the idle check does catch a timer that calls out", async () => {
  const r = await rogueRun;
  assert.ok(r.idleCalls.length > 0, "a planted timer that fetches must be seen");
  assert.equal(r.idleCalls[0].what, "fetch");
});

test("the phone sharing test page and the Render blueprint are gone", () => {
  const root = path.join(__dirname, "..");
  assert.equal(fs.existsSync(path.join(root, "web", "public", "share-test.html")), false);
  assert.equal(fs.existsSync(path.join(root, "render.yaml")), false);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "server.js"), "utf8"), /share-test/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "web", "routes.js"), "utf8"), /share-test/);
});
