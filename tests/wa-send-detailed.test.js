const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const wa = require("../lib/wa.js");

test("success returns the wamid", async (t) => {
  let posted;
  t.mock.method(axios, "post", async (url, payload) => {
    posted = payload;
    return { data: { messages: [{ id: "wamid.ABC" }] } };
  });
  const r = await wa.sendTextDetailed("97411111111", "Hello");
  assert.deepEqual(r, { ok: true, id: "wamid.ABC" });
  assert.equal(posted.type, "text");
  assert.equal(posted.to, "97411111111");
  assert.equal(posted.text.body, "Hello");
});

test("Graph error returns code + details", async (t) => {
  t.mock.method(axios, "post", async () => {
    const err = new Error("Request failed with status code 400");
    err.response = { data: { error: { code: 131030, message: "(#131030) Recipient phone number not in allowed list", error_data: { details: "Recipient phone number not in allowed list" } } } };
    throw err;
  });
  const r = await wa.sendTextDetailed("97411111111", "Hello");
  assert.equal(r.ok, false);
  assert.equal(r.code, 131030);
  assert.equal(r.message, "Recipient phone number not in allowed list");
});

test("network error has null code and the error message", async (t) => {
  t.mock.method(axios, "post", async () => { throw new Error("ECONNRESET"); });
  const r = await wa.sendTextDetailed("97411111111", "Hello");
  assert.deepEqual(r, { ok: false, code: null, message: "ECONNRESET" });
});
