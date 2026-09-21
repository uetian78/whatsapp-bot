const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const { Readable } = require("node:stream");
const FormData = require("form-data");
const wa = require("../lib/wa.js");

test("success returns the wamid", async (t) => {
  let posted;
  let config;
  t.mock.method(axios, "post", async (url, payload, cfg) => {
    posted = payload;
    config = cfg;
    return { data: { messages: [{ id: "wamid.ABC" }] } };
  });
  const r = await wa.sendTextDetailed("97411111111", "Hello");
  assert.deepEqual(r, { ok: true, id: "wamid.ABC" });
  assert.equal(posted.type, "text");
  assert.equal(posted.to, "97411111111");
  assert.equal(posted.text.body, "Hello");
  assert.equal(config.timeout, 20000);
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

test("sendDocumentDetailed: success returns the wamid, no caption", async (t) => {
  let posted;
  let config;
  t.mock.method(axios, "post", async (url, payload, cfg) => {
    posted = payload;
    config = cfg;
    return { data: { messages: [{ id: "wamid.DOC" }] } };
  });
  const r = await wa.sendDocumentDetailed("97411111111", "media.9", "file.pdf");
  assert.deepEqual(r, { ok: true, id: "wamid.DOC" });
  assert.deepEqual(posted, {
    messaging_product: "whatsapp",
    to: "97411111111",
    type: "document",
    document: { id: "media.9", filename: "file.pdf" },
  });
  assert.equal(config.timeout, 20000);
});

test("sendDocumentDetailed: Graph error returns code + details", async (t) => {
  t.mock.method(axios, "post", async () => {
    const err = new Error("Request failed with status code 400");
    err.response = { data: { error: { code: 131026, message: "(#131026) Message undeliverable", error_data: { details: "Message undeliverable" } } } };
    throw err;
  });
  const r = await wa.sendDocumentDetailed("97411111111", "media.9", "file.pdf");
  assert.equal(r.ok, false);
  assert.equal(r.code, 131026);
  assert.equal(r.message, "Message undeliverable");
});

test("uploadMediaStream: sends a FormData stream body with Infinity limits and returns the id", async (t) => {
  let posted;
  let config;
  t.mock.method(axios, "post", async (url, payload, cfg) => {
    posted = payload;
    config = cfg;
    return { data: { id: "media.upload.123" } };
  });
  const stream = Readable.from(["hello world"]);
  const id = await wa.uploadMediaStream(stream, "notes.txt", 11);
  assert.equal(id, "media.upload.123");
  assert.ok(posted instanceof FormData);
  assert.equal(config.maxBodyLength, Infinity);
  assert.equal(config.maxContentLength, Infinity);
  assert.equal(config.timeout, 10 * 60 * 1000);
});

test("uploadMediaStream: never buffers the stream itself, propagates axios failure", async (t) => {
  t.mock.method(axios, "post", async () => { throw new Error("Graph rejected upload"); });
  const stream = Readable.from(["x"]);
  await assert.rejects(() => wa.uploadMediaStream(stream, "a.pdf", 1), /Graph rejected upload/);
});
