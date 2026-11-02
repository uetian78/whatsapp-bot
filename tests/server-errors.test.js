// What the public sees when a request goes wrong, against the real server.js
// started with NODE_ENV unset (Express's default would then print a stack trace
// with file paths), and what the Dockerfile and .dockerignore promise.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { fork } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
}

function request(port, method, urlPath, { body, type } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: "127.0.0.1", port, method, path: urlPath,
      headers: body === undefined ? {} : { "content-type": type || "application/json", "content-length": Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"] || "", text: Buffer.concat(chunks).toString() }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "errors-test-"));
  const port = await freePort();
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    GOOGLE_SHEET_ID: "dummy-sheet", GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    WEB_SECRET: "x".repeat(40), ADMIN_PASSWORD: "not-a-real-password", DATA_DIR: dir, PORT: String(port),
  };
  assert.equal(env.NODE_ENV, undefined, "this test needs NODE_ENV unset");
  const child = fork(path.join(ROOT, "server.js"), [], { cwd: dir, env, silent: true });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  try {
    for (let i = 0; i < 600 && !/Listening on/.test(out); i++) {
      if (child.exitCode !== null) throw new Error("server exited early:\n" + out);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(out, /Listening on/);
    await fn(port);
  } finally {
    child.kill();
    await new Promise((r) => child.once("exit", r));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch (_) { /* a temp dir left behind is harmless */ }
  }
}

const LEAKS = /\bat\s+\S+\s+\(|node_modules|SyntaxError|\.js:\d+|[A-Za-z]:\\/;

test("bad JSON, without credentials, answers a short JSON error and never a stack or a path", async () => {
  await withServer(async (port) => {
    for (const p of ["/", "/app/api/messages", "/webhook", "/drive-index"]) {
      const r = await request(port, "POST", p, { body: "{not json" });
      assert.equal(r.status, 400, p);
      assert.match(r.type, /json/, p);
      assert.doesNotMatch(r.text, LEAKS, `${p} leaked: ${r.text.slice(0, 200)}`);
      assert.ok(r.text.length < 200, p);
    }
  });
});

test("the front page is neutral, and a missing route doesn't name the stack", async () => {
  await withServer(async (port) => {
    const home = await request(port, "GET", "/");
    assert.equal(home.status, 200);
    assert.match(home.text, /HVAC Assistant/);
    assert.doesNotMatch(home.text, /WhatsApp|Mannai/i);
    const missing = await request(port, "GET", "/no-such-page");
    assert.equal(missing.status, 404);
    assert.doesNotMatch(missing.text, LEAKS);
  });
});

test("the Dockerfile runs in production mode and says Railway, and replay captures stay out of the image", () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^ENV NODE_ENV=production$/m);
  assert.doesNotMatch(dockerfile, /Render/);
  assert.match(dockerfile, /Railway/);
  const ignore = fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8").split(/\r?\n/);
  assert.ok(ignore.includes("tests/replay/*.local.json"));
});
