const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const wa = require("../lib/wa.js");

test("getNumberStatus returns the phone number's status field", async (t) => {
  let url;
  t.mock.method(axios, "get", async (u) => {
    url = u;
    return { data: { status: "PENDING", id: "1" } };
  });
  assert.equal(await wa.getNumberStatus(), "PENDING");
  assert.match(url, /fields=status/);
});

test("registerNumber posts the PIN to /register", async (t) => {
  let url;
  let posted;
  t.mock.method(axios, "post", async (u, payload) => {
    url = u;
    posted = payload;
    return { data: { success: true } };
  });
  await wa.registerNumber("123456");
  assert.match(url, /\/register$/);
  assert.deepEqual(posted, { messaging_product: "whatsapp", pin: "123456" });
});

test("Graph errors surface Meta's message", async (t) => {
  t.mock.method(axios, "post", async () => {
    const err = new Error("Request failed with status code 400");
    err.response = { data: { error: { code: 133005, message: "(#133005) Two step verification PIN Mismatch" } } };
    throw err;
  });
  await assert.rejects(wa.registerNumber("123456"), /PIN Mismatch/);
});

test("registerNumber treats success:false as a failure", async (t) => {
  t.mock.method(axios, "post", async () => ({ data: { success: false } }));
  await assert.rejects(wa.registerNumber("123456"), /success/);
});
