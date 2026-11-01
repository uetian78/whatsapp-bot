const test = require("node:test");
const assert = require("node:assert");
const { requireAdmin } = require("../lib/http-auth.js");

function basic(user, pass) {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

// Runs the middleware against a fake req/res and reports what it did.
function run(env, authorization) {
  const out = { status: null, headers: {}, body: null, nextCalled: false };
  const req = { headers: authorization === undefined ? {} : { authorization } };
  const res = {
    status(code) { out.status = code; return res; },
    set(k, v) { out.headers[k] = v; return res; },
    type() { return res; },
    send(b) { out.body = b; return res; },
    json(b) { out.body = b; return res; },
    sendStatus(code) { out.status = code; return res; },
  };
  requireAdmin(env)(req, res, () => { out.nextCalled = true; });
  return out;
}

test("requireAdmin: no Authorization header -> 401 with a Basic challenge", () => {
  const r = run({ ADMIN_PASSWORD: "s3cret" });
  assert.equal(r.status, 401);
  assert.match(r.headers["WWW-Authenticate"], /^Basic/);
  assert.equal(r.nextCalled, false);
});

test("requireAdmin: wrong password -> 401 with a Basic challenge", () => {
  const r = run({ ADMIN_PASSWORD: "s3cret" }, basic("admin", "nope"));
  assert.equal(r.status, 401);
  assert.match(r.headers["WWW-Authenticate"], /^Basic/);
  assert.equal(r.nextCalled, false);
});

test("requireAdmin: a password of a different length is refused, not thrown", () => {
  for (const pw of ["", "s", "s3cret-and-much-longer"]) {
    const r = run({ ADMIN_PASSWORD: "s3cret" }, basic("admin", pw));
    assert.equal(r.status, 401, JSON.stringify(pw));
    assert.equal(r.nextCalled, false);
  }
});

test("requireAdmin: right password calls next, whatever the username", () => {
  for (const user of ["admin", "anyone", ""]) {
    const r = run({ ADMIN_PASSWORD: "s3cret" }, basic(user, "s3cret"));
    assert.equal(r.nextCalled, true, `user ${JSON.stringify(user)}`);
    assert.equal(r.status, null);
  }
});

test("requireAdmin: a password containing a colon still matches", () => {
  const r = run({ ADMIN_PASSWORD: "a:b:c" }, basic("admin", "a:b:c"));
  assert.equal(r.nextCalled, true);
});

test("requireAdmin: malformed or non-Basic headers are refused", () => {
  for (const h of ["Bearer s3cret", "Basic", "Basic !!!notbase64", "s3cret"]) {
    const r = run({ ADMIN_PASSWORD: "s3cret" }, h);
    assert.equal(r.status, 401, h);
    assert.equal(r.nextCalled, false);
  }
});

test("requireAdmin: ADMIN_PASSWORD unset -> 503, even with credentials", () => {
  for (const env of [{}, { ADMIN_PASSWORD: "" }]) {
    const r = run(env, basic("admin", ""));
    assert.equal(r.status, 503);
    assert.equal(r.nextCalled, false);
  }
});
