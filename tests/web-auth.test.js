const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { parseAccounts } = require("../lib/accounts.js");
const {
  makeInviteToken, verifyInviteToken, makeSession, readSession, requireUser, joinRoutes,
} = require("../web/auth.js");

const SECRET = "test-secret-not-real-1";
const OTHER = "test-secret-not-real-2";
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function accountsOf(...rows) { return parseAccounts(rows); }
const OK = () => accountsOf(["97455551111", "Sara <b>"], ["97455552222", "Omar"]);

// A real server on a free port, mounted like server.js mounts it.
async function serve({ secret = SECRET, getAccounts = async () => OK(), now = () => T0 } = {}) {
  const app = express();
  app.set("trust proxy", 1);
  app.use("/app", joinRoutes({ secret, getAccounts, now }));
  app.get("/app/", requireUser({ secret, getAccounts, now }), (req, res) => res.json({ who: req.account }));
  app.get("/app/api/x", requireUser({ secret, getAccounts, now }), (req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, opts = {}) => fetch(base + path, { redirect: "manual", ...opts });
  return { base, call, close: () => new Promise((r) => server.close(r)) };
}

const invite = (n = "97455551111", o = {}) => makeInviteToken(n, { secret: SECRET, now: T0, ...o });
const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];

// ---- tokens ----
test("an invite token verifies and gives the number back", () => {
  assert.deepEqual(verifyInviteToken(invite(), { secret: SECRET, now: T0 }), { number: "97455551111" });
});
test("an invite expires after 14 days by default, and the day count can be changed", () => {
  const t = invite();
  assert.ok(verifyInviteToken(t, { secret: SECRET, now: T0 + 13 * DAY }));
  assert.equal(verifyInviteToken(t, { secret: SECRET, now: T0 + 15 * DAY }), null);
  const short = invite("97455551111", { days: 1 });
  assert.equal(verifyInviteToken(short, { secret: SECRET, now: T0 + 2 * DAY }), null);
});
test("a token made with another secret, or edited, does not verify", () => {
  assert.equal(verifyInviteToken(makeInviteToken("97455551111", { secret: OTHER, now: T0 }), { secret: SECRET, now: T0 }), null);
  const [p, h] = invite().split(".");
  const forged = Buffer.from(JSON.stringify({ p: "invite", n: "97455559999", exp: T0 + DAY })).toString("base64url");
  assert.equal(verifyInviteToken(`${forged}.${h}`, { secret: SECRET, now: T0 }), null);
  assert.equal(verifyInviteToken(`${p}.${h.slice(0, -2)}xx`, { secret: SECRET, now: T0 }), null);
});
test("junk never throws: bad base64, bad JSON, non-object payloads, wrong lengths", () => {
  const opts = { secret: SECRET, now: T0 };
  for (const junk of [undefined, null, "", ".", "a.b", "....", "%%%.%%%", "a".repeat(5000), 42, {}, [] ]) {
    assert.equal(verifyInviteToken(junk, opts), null);
    assert.equal(readSession(`hv_session=${junk}`, opts), null);
  }
  // Correctly signed, but the payload is not an object / not JSON.
  const crypto = require("node:crypto");
  const signed = (raw) => {
    const p = Buffer.from(raw).toString("base64url");
    return `${p}.${crypto.createHmac("sha256", SECRET).update(p).digest("base64url")}`;
  };
  for (const raw of ["not json", "42", "null", "[1,2]", '"str"']) {
    assert.equal(verifyInviteToken(signed(raw), opts), null, raw);
  }
});
test("with an empty secret nothing verifies and nothing is made", () => {
  assert.throws(() => makeInviteToken("97455551111", { secret: "", now: T0 }));
  assert.throws(() => makeSession("97455551111", { secret: undefined, now: T0 }));
  assert.equal(verifyInviteToken(invite(), { secret: "", now: T0 }), null);
});
test("an invite is not a session and a session is not an invite", () => {
  const opts = { secret: SECRET, now: T0 };
  const session = makeSession("97455551111", opts);
  assert.equal(verifyInviteToken(session, opts), null);
  assert.equal(readSession(`hv_session=${invite()}`, opts), null);
});
test("a session reads from a cookie header, tolerates junk and duplicates, and expires in 180 days", () => {
  const opts = { secret: SECRET, now: T0 };
  const s = makeSession("97455551111", opts);
  assert.deepEqual(readSession(`a=1; hv_session=${s}; b=2`, opts), { number: "97455551111" });
  assert.deepEqual(readSession(`;;; =x; hv_session=garbage; junk; hv_session=${s}; %zz=%`, opts), { number: "97455551111" });
  assert.deepEqual(readSession(`hv_session=${encodeURIComponent(s)}`, opts), { number: "97455551111" });
  assert.equal(readSession(undefined, opts), null);
  assert.equal(readSession("", opts), null);
  assert.ok(readSession(`hv_session=${s}`, { secret: SECRET, now: T0 + 179 * DAY }));
  assert.equal(readSession(`hv_session=${s}`, { secret: SECRET, now: T0 + 181 * DAY }), null);
});
test("now may be a number or a function", () => {
  const t = makeInviteToken("97455551111", { secret: SECRET, now: () => T0 });
  assert.ok(verifyInviteToken(t, { secret: SECRET, now: () => T0 + 1000 }));
});

// ---- join routes ----
test("opening an invite link never signs in", async () => {
  const s = await serve();
  const r = await s.call(`/app/join/${invite()}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("set-cookie"), null);
  const html = await r.text();
  assert.match(html, /Sign in to HVAC Assistant as Sara &lt;b&gt;/);
  assert.ok(!html.includes("Sara <b>"), "the name is HTML-escaped");
  assert.match(html, /<button[^>]*>Sign in<\/button>/);
  assert.match(html, /<form method="post" action="\/app\/join\//);
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.match(r.headers.get("cache-control"), /no-store/);
  await s.close();
});

test("pressing the button signs in with an HttpOnly, SameSite=Lax cookie", async () => {
  const s = await serve();
  const r = await s.call(`/app/join/${invite()}`, { method: "POST" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/app/");
  const c = r.headers.get("set-cookie");
  assert.match(c, /^hv_session=/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\/app(;|$)/);
  assert.match(c, new RegExp(`Max-Age=${180 * 24 * 3600}`));
  assert.ok(!/Secure/.test(c), "plain http: no Secure");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.match(r.headers.get("cache-control"), /no-store/);
  const me = await s.call("/app/", { headers: { cookie: cookieOf(r) } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).who.number, "97455551111");
  await s.close();
});

test("the cookie is Secure when the request came in over https via the proxy", async () => {
  const s = await serve();
  const r = await s.call(`/app/join/${invite()}`, { method: "POST", headers: { "x-forwarded-proto": "https" } });
  assert.match(r.headers.get("set-cookie"), /; Secure/);
  await s.close();
});

test("tampered and expired invites show the expired-link page and sign nobody in", async () => {
  const s = await serve();
  const good = invite();
  const bad = [good.slice(0, -3) + "AAA", invite("97455551111", { now: T0 - 20 * DAY }), "nonsense", makeInviteToken("97455551111", { secret: OTHER, now: T0 })];
  for (const t of bad) {
    for (const method of ["GET", "POST"]) {
      const r = await s.call(`/app/join/${t}`, { method });
      assert.equal(r.status, 410, `${method} ${t.slice(0, 8)}`);
      assert.equal(r.headers.get("set-cookie"), null);
      assert.match(await r.text(), /This link has expired\. Ask for a new one\./);
    }
  }
  await s.close();
});

test("a session token cannot be used as an invite link", async () => {
  const s = await serve();
  const session = makeSession("97455551111", { secret: SECRET, now: T0 });
  const r = await s.call(`/app/join/${session}`, { method: "POST" });
  assert.equal(r.status, 410);
  assert.equal(r.headers.get("set-cookie"), null);
  await s.close();
});

test("an invite for a number not on the Allowed tab signs nobody in", async () => {
  const s = await serve();
  const t = invite("97455559999");
  const g = await s.call(`/app/join/${t}`);
  assert.equal(g.status, 410);
  const p = await s.call(`/app/join/${t}`, { method: "POST" });
  assert.equal(p.status, 410);
  assert.equal(p.headers.get("set-cookie"), null);
  await s.close();
});

test("a cross-site POST to the join page is refused, and a same-site one is allowed", async () => {
  const s = await serve();
  const url = `/app/join/${invite()}`;
  const evil = await s.call(url, { method: "POST", headers: { origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get("set-cookie"), null);
  const same = await s.call(url, { method: "POST", headers: { origin: s.base } });
  assert.equal(same.status, 303);
  const none = await s.call(url, { method: "POST" });
  assert.equal(none.status, 303);
  // Browsers send Origin: null when the page says no-referrer, so Sec-Fetch-Site decides.
  const nullSame = await s.call(url, { method: "POST", headers: { origin: "null", "sec-fetch-site": "same-origin" } });
  assert.equal(nullSame.status, 303);
  const nullCross = await s.call(url, { method: "POST", headers: { origin: "null", "sec-fetch-site": "cross-site" } });
  assert.equal(nullCross.status, 403);
  const nullBare = await s.call(url, { method: "POST", headers: { origin: "null" } });
  assert.equal(nullBare.status, 403);
  const crossSite = await s.call(url, { method: "POST", headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.status, 403);
  await s.close();
});

test("an unreadable Sheet at the join page gives 503, never a cookie", async () => {
  const s = await serve({ getAccounts: async () => { throw new Error("sheet down"); } });
  for (const method of ["GET", "POST"]) {
    const r = await s.call(`/app/join/${invite()}`, { method });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("set-cookie"), null);
  }
  await s.close();
});

// ---- requireUser ----
test("no session: 401 JSON for the API and other requests, an HTML page for browser navigation", async () => {
  const s = await serve();
  const nav = await s.call("/app/", { headers: { accept: "text/html,application/xhtml+xml" } });
  assert.equal(nav.status, 401);
  assert.match(nav.headers.get("content-type"), /text\/html/);
  assert.match(await nav.text(), /Ask for your personal link to sign in\./);
  const api = await s.call("/app/api/x", { headers: { accept: "text/html" } });
  assert.equal(api.status, 401);
  assert.match(api.headers.get("content-type"), /json/);
  const json = await s.call("/app/", { headers: { accept: "application/json" } });
  assert.equal(json.status, 401);
  assert.match(json.headers.get("content-type"), /json/);
  assert.match((await json.json()).error, /personal link/);
  await s.close();
});

test("a forged or expired session cookie is a 401", async () => {
  const s = await serve();
  const old = makeSession("97455551111", { secret: SECRET, now: T0 - 200 * DAY });
  for (const c of ["hv_session=junk", `hv_session=${old}`, `hv_session=${makeSession("97455551111", { secret: OTHER, now: T0 })}`]) {
    const r = await s.call("/app/", { headers: { cookie: c } });
    assert.equal(r.status, 401);
  }
  await s.close();
});

test("a signed-in person removed from Allowed gets 401 on the next request", async () => {
  let accounts = OK();
  const s = await serve({ getAccounts: async () => accounts });
  const login = await s.call(`/app/join/${invite()}`, { method: "POST" });
  const headers = { cookie: cookieOf(login), accept: "text/html" };
  assert.equal((await s.call("/app/", { headers })).status, 200);
  accounts = accountsOf(["97455552222", "Omar"]);
  const after = await s.call("/app/", { headers });
  assert.equal(after.status, 401);
  assert.match(await after.text(), /Ask for your personal link to sign in\./);
  await s.close();
});

test("an unreadable Sheet with no saved list gives 503, never access", async () => {
  let down = false;
  const s = await serve({ getAccounts: async () => { if (down) throw new Error("no sheet"); return OK(); } });
  const login = await s.call(`/app/join/${invite()}`, { method: "POST" });
  down = true;
  const r = await s.call("/app/", { headers: { cookie: cookieOf(login) } });
  assert.equal(r.status, 503);
  await s.close();
});

test("WEB_SECRET unset makes every /app request 503", async () => {
  const s = await serve({ secret: "" });
  for (const [path, method] of [["/app/", "GET"], ["/app/api/x", "GET"], [`/app/join/${invite()}`, "GET"], [`/app/join/${invite()}`, "POST"], ["/app/anything", "GET"]]) {
    const r = await s.call(path, { method });
    assert.equal(r.status, 503, `${method} ${path.slice(0, 14)}`);
    assert.equal(r.headers.get("set-cookie"), null);
  }
  await s.close();
});

// ---- scripts/make-invite.js ----
const { run: makeInvite } = require("../scripts/make-invite.js");

test("make-invite prints a link that the sign-in accepts", () => {
  const env = { WEB_SECRET: SECRET, PUBLIC_URL: "https://hvac.example.test/" };
  const r = makeInvite({ argv: ["+974 5555 1111"], env, now: T0 });
  assert.equal(r.code, 0);
  const m = /^https:\/\/hvac\.example\.test\/app\/join\/([^/]+)$/.exec(r.out);
  assert.ok(m, "PUBLIC_URL/app/join/<token> with the trailing slash dropped");
  assert.deepEqual(verifyInviteToken(m[1], { secret: SECRET, now: T0 }), { number: "97455551111" });
});

test("make-invite exits non-zero with a clear message when something is missing or wrong", () => {
  const env = { WEB_SECRET: SECRET, PUBLIC_URL: "https://hvac.example.test" };
  const cases = [
    [[], env, /Usage/],
    [["abc"], env, /not a phone number/],
    [["123"], env, /7 to 15 digits/],
    [["97455551111"], { PUBLIC_URL: env.PUBLIC_URL }, /WEB_SECRET/],
    [["97455551111"], { WEB_SECRET: SECRET }, /PUBLIC_URL/],
    [["97455551111"], { WEB_SECRET: SECRET, PUBLIC_URL: "not a url" }, /PUBLIC_URL/],
  ];
  for (const [argv, e, msg] of cases) {
    const r = makeInvite({ argv, env: e, now: T0 });
    assert.equal(r.code, 1);
    assert.match(r.err, msg);
    assert.equal(r.out, "");
    assert.ok(!r.err.includes(SECRET));
  }
});

test("run as a command, make-invite prints the link and exits 0, or the problem and exits 1", () => {
  const { spawnSync } = require("node:child_process");
  const script = require("node:path").join(__dirname, "..", "scripts", "make-invite.js");
  const env = { ...process.env, WEB_SECRET: SECRET, PUBLIC_URL: "http://localhost:3000" };
  const ok = spawnSync(process.execPath, [script, "97455551111"], { env, encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^http:\/\/localhost:3000\/app\/join\/\S+\n$/);
  const bad = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Usage/);
});
