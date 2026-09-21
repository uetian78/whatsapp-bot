const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const http = require("node:http");
const { createSenderRouter } = require("../lib/sender-api.js");
const { createStatusStore } = require("../lib/sender-status.js");

const PIN = "1234";

function fakeFile(id, name) {
  return { id, name, folder: "" };
}

async function withServer(deps, fn) {
  const statusStore = deps.statusStore || createStatusStore();
  const app = express();
  app.use("/api/sender", createSenderRouter({
    pin: PIN,
    loadAccounts: async () => new Map([
      ["97422222222", { number: "97422222222", name: "Zed", paid: false }],
      ["97411111111", { number: "97411111111", name: "Ahmed", paid: true }],
    ]),
    polish: async () => ({ ok: true, draft: "Polished." }),
    sendMessage: async () => ({ ok: true, id: "wamid.1" }),
    searchFiles: async () => [],
    findFileById: async () => null,
    uploadDriveFile: async () => "media.default",
    uploadStream: async () => "media.default",
    sendDocument: async () => ({ ok: true, id: "wamid.doc" }),
    ...deps,
    statusStore,
  }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/sender`;
  const call = (path, { method = "GET", body, pin = PIN } = {}) =>
    fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(pin !== null ? { "X-Sender-Pin": pin } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
  try { await fn(call, statusStore, base); } finally { server.close(); }
}

// Bypasses fetch's automatic Content-Length/body handling so tests can send
// a request with no Content-Length header at all, or a bogus one — fetch
// would otherwise compute and inject a correct one from the body itself.
function rawPost(base, path, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const req = http.request(url, { method: "POST", headers: { Connection: "close", ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("disabled when no PIN is configured", async () => {
  await withServer({ pin: "" }, async (call) => {
    const r = await call("/contacts");
    assert.equal(r.status, 503);
    assert.equal(r.json.error, "sender_disabled");
  });
});

test("wrong or missing PIN is 401", async () => {
  await withServer({}, async (call) => {
    assert.equal((await call("/contacts", { pin: "9999" })).status, 401);
    assert.equal((await call("/contacts", { pin: null })).status, 401);
  });
});

test("contacts come back sorted by name", async () => {
  await withServer({}, async (call) => {
    const r = await call("/contacts");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.contacts, [
      { number: "97411111111", name: "Ahmed" },
      { number: "97422222222", name: "Zed" },
    ]);
  });
});

test("contacts: sheet failure is 502", async () => {
  await withServer({ loadAccounts: async () => { throw new Error("quota"); } }, async (call) => {
    const r = await call("/contacts");
    assert.equal(r.status, 502);
    assert.equal(r.json.error, "sheet_unavailable");
  });
});

test("polish validates input and passes it through", async () => {
  let got;
  await withServer({ polish: async (o) => { got = o; return { ok: true, draft: "مرحبا" }; } }, async (call) => {
    assert.equal((await call("/polish", { method: "POST", body: { text: "  ", language: "en" } })).json.error, "empty_text");
    assert.equal((await call("/polish", { method: "POST", body: { text: "hi", language: "fr" } })).json.error, "bad_language");
    const r = await call("/polish", { method: "POST", body: { text: " hi ", language: "ar", instruction: " shorter " } });
    assert.equal(r.status, 200);
    assert.equal(r.json.draft, "مرحبا");
    assert.deepEqual(got, { text: "hi", language: "ar", instruction: "shorter" });
  });
});

test("polish: AI unavailable is 503 with the reason", async () => {
  await withServer({ polish: async () => ({ ok: false, message: "credits exhausted" }) }, async (call) => {
    const r = await call("/polish", { method: "POST", body: { text: "hi", language: "en" } });
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { error: "ai_unavailable", message: "credits exhausted" });
  });
});

test("send normalises the number, validates, and tracks the wamid", async () => {
  let sentTo;
  await withServer({ sendMessage: async (to) => { sentTo = to; return { ok: true, id: "wamid.9" }; } }, async (call, store) => {
    assert.equal((await call("/send", { method: "POST", body: { to: "+974 123", text: "x" } })).json.error, "bad_number");
    assert.equal((await call("/send", { method: "POST", body: { to: "97411111111", text: " " } })).json.error, "empty_text");
    assert.equal((await call("/send", { method: "POST", body: { to: "97411111111", text: "a".repeat(4097) } })).json.error, "too_long");
    const r = await call("/send", { method: "POST", body: { to: "+974 1111-1111", text: "Hello" } });
    assert.deepEqual(r.json, { ok: true, id: "wamid.9", ids: ["wamid.9"] });
    assert.equal(sentTo, "97411111111");
    assert.equal(store.get("wamid.9").status, "pending");
  });
});

test("send: Graph error is 502 with outsideWindow flag", async () => {
  await withServer({ sendMessage: async () => ({ ok: false, code: 131047, message: "Re-engagement" }) }, async (call) => {
    const r = await call("/send", { method: "POST", body: { to: "97411111111", text: "Hello" } });
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { ok: false, code: 131047, message: "Re-engagement", outsideWindow: true, failedItem: "message", ids: [] });
  });
});

test("lockout: 20 wrong PINs lock every route for 15 minutes, even with the right PIN", async () => {
  let t = 0;
  await withServer({ now: () => t }, async (call) => {
    for (let i = 0; i < 20; i++) {
      const r = await call("/contacts", { pin: "9999" });
      assert.equal(r.status, 401);
    }
    // 21st attempt (even with correct PIN) is locked
    const locked = await call("/contacts");
    assert.equal(locked.status, 429);
    assert.deepEqual(locked.json, { error: "locked" });

    // still locked just before 15 minutes pass
    t = 15 * 60 * 1000 - 1;
    const stillLocked = await call("/contacts");
    assert.equal(stillLocked.status, 429);

    // lockout expires after 15 minutes
    t = 15 * 60 * 1000 + 1;
    const ok = await call("/contacts");
    assert.equal(ok.status, 200);
  });
});

test("a correct PIN outside lockout resets the failure counter", async () => {
  let t = 0;
  await withServer({ now: () => t }, async (call) => {
    for (let i = 0; i < 10; i++) {
      assert.equal((await call("/contacts", { pin: "9999" })).status, 401);
    }
    // correct PIN resets the counter
    assert.equal((await call("/contacts")).status, 200);
    // another 19 failures shouldn't trip the lock (counter was reset)
    for (let i = 0; i < 19; i++) {
      assert.equal((await call("/contacts", { pin: "9999" })).status, 401);
    }
    assert.equal((await call("/contacts")).status, 200);
  });
});

test("send: ok:true with no id is a 502 and nothing is tracked", async () => {
  await withServer({ sendMessage: async () => ({ ok: true }) }, async (call, store) => {
    const r = await call("/send", { method: "POST", body: { to: "97411111111", text: "Hello" } });
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { ok: false, code: null, message: "WhatsApp did not return a message id", outsideWindow: false, failedItem: "message", ids: [] });
    assert.equal(store.get(undefined), null);
  });
});

// ── Attachments ──────────────────────────────────────────────────────────

test("send: attachments must be an array", async () => {
  await withServer({}, async (call) => {
    const r = await call("/send", { method: "POST", body: { to: "97411111111", text: "hi", attachments: "nope" } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "bad_attachment");
  });
});

test("send: more than 5 attachments is too_many_attachments", async () => {
  await withServer({}, async (call) => {
    const attachments = Array.from({ length: 6 }, (_, i) => ({ kind: "upload", mediaId: `m${i}`, name: `f${i}.pdf` }));
    const r = await call("/send", { method: "POST", body: { to: "97411111111", text: "hi", attachments } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "too_many_attachments");
  });
});

test("send: malformed attachment item is bad_attachment", async () => {
  await withServer({}, async (call) => {
    const missingId = await call("/send", { method: "POST", body: { to: "97411111111", text: "hi", attachments: [{ kind: "library" }] } });
    assert.equal(missingId.status, 400);
    assert.equal(missingId.json.error, "bad_attachment");

    const badKind = await call("/send", { method: "POST", body: { to: "97411111111", text: "hi", attachments: [{ kind: "carrier_pigeon", id: "x" }] } });
    assert.equal(badKind.status, 400);
    assert.equal(badKind.json.error, "bad_attachment");

    const missingUploadName = await call("/send", { method: "POST", body: { to: "97411111111", text: "hi", attachments: [{ kind: "upload", mediaId: "m1" }] } });
    assert.equal(missingUploadName.status, 400);
    assert.equal(missingUploadName.json.error, "bad_attachment");
  });
});

test("send: unknown library file id is unknown_file, resolved before anything is sent", async () => {
  let sendMessageCalled = false;
  await withServer({
    sendMessage: async () => { sendMessageCalled = true; return { ok: true, id: "wamid.x" }; },
    findFileById: async () => null,
  }, async (call) => {
    const r = await call("/send", { method: "POST", body: { to: "97411111111", text: "hi", attachments: [{ kind: "library", id: "drive1" }] } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "unknown_file");
  });
  assert.equal(sendMessageCalled, false);
});

test("send: text blank with no attachments is empty_text", async () => {
  await withServer({}, async (call) => {
    const r = await call("/send", { method: "POST", body: { to: "97411111111", text: "  ", attachments: [] } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "empty_text");
  });
});

test("send: blank text with a valid attachment is allowed", async () => {
  await withServer({
    findFileById: async (id) => fakeFile(id, "Report.pdf"),
    uploadDriveFile: async () => "media.1",
    sendDocument: async () => ({ ok: true, id: "wamid.doc1" }),
  }, async (call) => {
    const r = await call("/send", { method: "POST", body: { to: "97411111111", text: "   ", attachments: [{ kind: "library", id: "drive1" }] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, id: "wamid.doc1", ids: ["wamid.doc1"] });
  });
});

test("send: text then attachments in order (library + upload mixed), all ids tracked", async () => {
  const calls = [];
  await withServer({
    sendMessage: async (to, text) => { calls.push(["text", text]); return { ok: true, id: "wamid.text" }; },
    findFileById: async (id) => fakeFile(id, "Drawing.pdf"),
    uploadDriveFile: async (f) => { calls.push(["uploadDrive", f.name]); return "media.drive"; },
    sendDocument: async (to, mediaId, name) => { calls.push(["sendDoc", name, mediaId]); return { ok: true, id: `wamid.${name}` }; },
  }, async (call, store) => {
    const r = await call("/send", {
      method: "POST",
      body: {
        to: "97411111111",
        text: "Hello",
        attachments: [
          { kind: "library", id: "drive1" },
          { kind: "upload", mediaId: "media.up", name: "Photo.jpg" },
        ],
      },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, id: "wamid.text", ids: ["wamid.text", "wamid.Drawing.pdf", "wamid.Photo.jpg"] });
    assert.deepEqual(calls, [
      ["text", "Hello"],
      ["uploadDrive", "Drawing.pdf"],
      ["sendDoc", "Drawing.pdf", "media.drive"],
      ["sendDoc", "Photo.jpg", "media.up"],
    ]);
    assert.equal(store.get("wamid.text").status, "pending");
    assert.equal(store.get("wamid.Drawing.pdf").status, "pending");
    assert.equal(store.get("wamid.Photo.jpg").status, "pending");
  });
});

test("send: stops at first attachment failure (413 from Drive fetch), ids already sent come back", async () => {
  await withServer({
    sendMessage: async () => ({ ok: true, id: "wamid.text" }),
    findFileById: async (id) => fakeFile(id, "Big.pdf"),
    uploadDriveFile: async () => { const e = new Error("too big"); e.response = { status: 413 }; throw e; },
  }, async (call) => {
    const r = await call("/send", { method: "POST", body: { to: "97411111111", text: "Hello", attachments: [{ kind: "library", id: "drive1" }] } });
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, {
      ok: false, code: null, message: "File is larger than WhatsApp's 100 MB limit",
      outsideWindow: false, failedItem: "Big.pdf", ids: ["wamid.text"],
    });
  });
});

test("send: non-413 Drive fetch failure gives a friendly message", async () => {
  await withServer({
    sendMessage: async () => ({ ok: true, id: "wamid.text" }),
    findFileById: async (id) => fakeFile(id, "Notes.pdf"),
    uploadDriveFile: async () => { throw new Error("network blip"); },
  }, async (call) => {
    const r = await call("/send", { method: "POST", body: { to: "97411111111", text: "Hello", attachments: [{ kind: "library", id: "drive1" }] } });
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, {
      ok: false, code: null, message: "Couldn't fetch Notes.pdf from the library",
      outsideWindow: false, failedItem: "Notes.pdf", ids: ["wamid.text"],
    });
  });
});

test("send: sendDocument returning ok without id is a missing-id 502 with failedItem", async () => {
  await withServer({
    sendMessage: async () => ({ ok: true, id: "wamid.text" }),
    findFileById: async (id) => fakeFile(id, "Plan.pdf"),
    uploadDriveFile: async () => "media.plan",
    sendDocument: async () => ({ ok: true }),
  }, async (call) => {
    const r = await call("/send", { method: "POST", body: { to: "97411111111", text: "Hello", attachments: [{ kind: "library", id: "drive1" }] } });
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, {
      ok: false, code: null, message: "WhatsApp did not return a message id",
      outsideWindow: false, failedItem: "Plan.pdf", ids: ["wamid.text"],
    });
  });
});

// ── GET /files ───────────────────────────────────────────────────────────

test("files: query under 2 chars (after trim) is empty_query", async () => {
  await withServer({}, async (call) => {
    const r1 = await call("/files?q=a");
    assert.equal(r1.status, 400);
    assert.equal(r1.json.error, "empty_query");

    const r2 = await call("/files?q=%20%20");
    assert.equal(r2.status, 400);
    assert.equal(r2.json.error, "empty_query");
  });
});

test("files: returns matches from searchFiles, capped at 20", async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `f${i}`, name: `File ${i}.pdf`, folder: "" }));
  let gotQuery;
  await withServer({ searchFiles: async (q) => { gotQuery = q; return many; } }, async (call) => {
    const r = await call("/files?q=report");
    assert.equal(r.status, 200);
    assert.equal(gotQuery, "report");
    assert.equal(r.json.files.length, 20);
    assert.deepEqual(r.json.files[0], many[0]);
  });
});

test("files: searchFiles failure is 502", async () => {
  await withServer({ searchFiles: async () => { throw new Error("drive down"); } }, async (call) => {
    const r = await call("/files?q=report");
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { error: "drive_unavailable", message: "drive down" });
  });
});

// ── POST /upload ─────────────────────────────────────────────────────────

test("upload: missing X-File-Name is bad_file_name", async () => {
  await withServer({}, async (_call, _store, base) => {
    const r = await rawPost(base, "/upload", {
      "X-Sender-Pin": PIN, "Content-Type": "application/octet-stream", "Content-Length": "3",
    }, Buffer.from("abc"));
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "bad_file_name");
  });
});

test("upload: undecodable X-File-Name is bad_file_name", async () => {
  await withServer({}, async (_call, _store, base) => {
    const r = await rawPost(base, "/upload", {
      "X-Sender-Pin": PIN, "X-File-Name": "%", "Content-Type": "application/octet-stream", "Content-Length": "3",
    }, Buffer.from("abc"));
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "bad_file_name");
  });
});

test("upload: missing Content-Length is 411", async () => {
  await withServer({}, async (_call, _store, base) => {
    const r = await rawPost(base, "/upload", {
      "X-Sender-Pin": PIN, "X-File-Name": "a.pdf", "Content-Type": "application/octet-stream",
    }, Buffer.from("abc"));
    assert.equal(r.status, 411);
    assert.equal(r.json.error, "length_required");
  });
});

test("upload: zero Content-Length is 411", async () => {
  // A syntactically invalid Content-Length (e.g. "notanumber") is rejected
  // by Node's HTTP parser itself before Express ever sees the request, so
  // that case can't be exercised at this layer. "0" is valid HTTP framing
  // but not a real upload — the route's own validation must reject it.
  await withServer({}, async (_call, _store, base) => {
    const r = await rawPost(base, "/upload", {
      "X-Sender-Pin": PIN, "X-File-Name": "a.pdf", "Content-Type": "application/octet-stream", "Content-Length": "0",
    }, Buffer.alloc(0));
    assert.equal(r.status, 411);
    assert.equal(r.json.error, "length_required");
  });
});

test("upload: Content-Length over the cap is 413 without reading the body", async () => {
  let called = false;
  await withServer({ uploadStream: async () => { called = true; return "x"; } }, async (_call, _store, base) => {
    const r = await rawPost(base, "/upload", {
      "X-Sender-Pin": PIN, "X-File-Name": "big.pdf", "Content-Type": "application/octet-stream",
      "Content-Length": String(100 * 1024 * 1024 + 1),
    }, Buffer.from("tiny"));
    assert.equal(r.status, 413);
    assert.equal(r.json.error, "too_large");
  });
  assert.equal(called, false);
});

test("upload: success streams the exact raw bytes to uploadStream and strips the path", async () => {
  const received = {};
  await withServer({
    uploadStream: async (stream, name, length) => {
      received.name = name;
      received.length = length;
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      received.bytes = Buffer.concat(chunks);
      return "media.upload.1";
    },
  }, async (_call, _store, base) => {
    const body = Buffer.from("hello world, this is a test file body");
    const r = await rawPost(base, "/upload", {
      "X-Sender-Pin": PIN,
      "X-File-Name": encodeURIComponent("some/folder\\report.pdf"),
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.length),
    }, body);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { mediaId: "media.upload.1", name: "report.pdf" });
    assert.equal(received.name, "report.pdf");
    assert.equal(received.length, body.length);
    assert.ok(received.bytes.equals(body));
  });
});

test("upload: uploadStream failure is 502", async () => {
  await withServer({ uploadStream: async () => { throw new Error("Graph rejected upload"); } }, async (_call, _store, base) => {
    const r = await rawPost(base, "/upload", {
      "X-Sender-Pin": PIN, "X-File-Name": "a.pdf", "Content-Type": "application/octet-stream", "Content-Length": "1",
    }, Buffer.from("x"));
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { error: "upload_failed", message: "Graph rejected upload" });
  });
});

test("upload: client disconnecting mid-upload aborts the outbound Graph request quickly", async () => {
  let receivedSignal = null;
  let sawAbort = false;
  let abortedAfterMs = null;
  let unhandled = null;
  const onUnhandledRejection = (err) => { unhandled = err; };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    await withServer({
      // Mimics wa.uploadMediaStream sitting in a long axios POST that only
      // settles once the caller aborts it — never resolves on its own.
      uploadStream: (stream, name, length, signal) => {
        receivedSignal = signal;
        return new Promise((_resolve, reject) => {
          const start = Date.now();
          signal.addEventListener("abort", () => {
            sawAbort = true;
            abortedAfterMs = Date.now() - start;
            reject(new Error("aborted"));
          });
        });
      },
    }, async (_call, _store, base) => {
      const url = new URL(base + "/upload");
      await new Promise((resolve) => {
        const req = http.request(url, {
          method: "POST",
          headers: {
            "X-Sender-Pin": PIN,
            "X-File-Name": "big.pdf",
            "Content-Type": "application/octet-stream",
            "Content-Length": "5000000", // declares far more than we actually send
          },
        });
        req.on("error", () => {}); // destroying the socket also errors this local request object; expected, ignore
        req.write(Buffer.from("only a few bytes, nowhere near the declared length"));
        // Give the server a tick to reach the route and call uploadStream
        // before we pull the rug out from under it.
        setTimeout(() => { req.destroy(); resolve(); }, 50);
      });

      const deadline = Date.now() + 900;
      while (!sawAbort && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
    });
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }

  assert.ok(receivedSignal instanceof AbortSignal, "uploadStream must receive an AbortSignal as its 4th argument");
  assert.ok(sawAbort, "the signal should abort once the client disconnects");
  assert.ok(abortedAfterMs < 1000, `abort should happen well under a second (took ${abortedAfterMs}ms)`);
  assert.equal(unhandled, null, `route must not produce an unhandled rejection: ${unhandled}`);
});

test("upload: success streams the exact raw bytes to uploadStream and strips the path (still green with the signal arg added)", async () => {
  const received = {};
  await withServer({
    uploadStream: async (stream, name, length, signal) => {
      received.name = name;
      received.length = length;
      received.hasSignal = signal instanceof AbortSignal;
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      received.bytes = Buffer.concat(chunks);
      return "media.upload.2";
    },
  }, async (_call, _store, base) => {
    const body = Buffer.from("another full body, sent completely this time");
    const r = await rawPost(base, "/upload", {
      "X-Sender-Pin": PIN,
      "X-File-Name": "report2.pdf",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.length),
    }, body);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { mediaId: "media.upload.2", name: "report2.pdf" });
    assert.equal(received.hasSignal, true);
    assert.ok(received.bytes.equals(body));
  });
});

test("upload: wrong PIN is 401 (PIN gate applies to /upload too)", async () => {
  await withServer({}, async (_call, _store, base) => {
    const r = await rawPost(base, "/upload", {
      "X-Sender-Pin": "9999", "X-File-Name": "a.pdf", "Content-Type": "application/octet-stream", "Content-Length": "1",
    }, Buffer.from("x"));
    assert.equal(r.status, 401);
  });
});

test("status reports the store and 404s unknown ids", async () => {
  await withServer({}, async (call, store) => {
    store.track("wamid.5");
    store.record({ id: "wamid.5", status: "failed", errors: [{ code: 131047, title: "Re-engagement message" }] });
    const r = await call("/status/wamid.5");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { status: "failed", code: 131047, message: "Re-engagement message", outsideWindow: true });
    const u = await call("/status/nope");
    assert.equal(u.status, 404);
    assert.equal(u.json.status, "unknown");
  });
});
