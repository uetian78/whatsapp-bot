const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const express = require("express");
const { parseAccounts } = require("../lib/accounts.js");
const { openDb } = require("../lib/db.js");
const { createConversations } = require("../lib/conversations.js");
const { createWebChannel } = require("../lib/channel-web.js");
const { mountWeb, makeSession, makeShareToken, verifyShareToken, makeInviteToken } = require("../web/auth.js");
const { createWebRoutes, contentDisposition, webErrorHandler } = require("../web/routes.js");
const { createUploadStore } = require("../web/uploads.js");

const SECRET = "test-secret-not-real-0000000000001";
const OTHER_SECRET = "test-secret-not-real-0000000000002";
const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const SARA = "97455551111";
const OMAR = "97455552222";
const CSP = "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const TOO_LARGE = "That file is too large. The limit is 32 MB.";
const BAD_TYPE = "Send a photo, PDF or Excel file.";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("[Content_Types].xmlxl/workbook.xml"), Buffer.alloc(32)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("notes.txt"), Buffer.alloc(32)]);
const XLS = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
const HEIC = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic"), Buffer.alloc(32)]);

const accounts = () => parseAccounts([[SARA, "Sara"], [OMAR, "Omar"]]);
const cookieFor = (n = SARA, secret = SECRET) => `hv_session=${makeSession(n, { secret, now: T0 })}`;

// A stream whose chunks are released one at a time, so a test can see that the
// first bytes reach the client before the rest exist.
function gatedStream(chunks) {
  let i = 0;
  const gates = [];
  const s = new Readable({
    read() {
      if (i >= chunks.length) return this.push(null);
      const chunk = chunks[i++];
      if (i === 1) return this.push(chunk);
      gates.push(() => this.push(chunk));
    },
  });
  s.release = () => { while (gates.length) gates.shift()(); };
  return s;
}

async function serve(o = {}) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvac-routes-"));
  const db = openDb(":memory:");
  const conversations = createConversations({ db, now });
  const uploads = o.uploads || createUploadStore({ now });
  const webChannel = createWebChannel({ conversations, dataDir: dir, now, uploads, crm: { logOutbound() {} } });
  const delivered = [];
  const deliverMessage = o.deliverMessage || (async (value, message, adapter) => { delivered.push({ value, message, adapter }); });
  const welcomes = [];
  const sendWelcome = o.sendWelcome || (async (account) => {
    welcomes.push(account.number);
    await new Promise((r) => setTimeout(r, 30));
    await webChannel.text(account.number, "WELCOME");
  });
  const calls = { drive: [], exports: [], streams: [] };
  const library = o.library || new Map();
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  mountWeb(app, { secret: SECRET, getAccounts: async () => accounts(), now });
  app.use(createWebRoutes({
    deliverMessage, conversations, webChannel, uploads, sendWelcome, now,
    secret: SECRET,
    publicUrl: "https://bot.example.test/",
    getFile: o.getFile || (async (id) => library.get(id) || null),
    streamDrive: o.streamDrive || (async (id) => { calls.drive.push(id); return Readable.from([Buffer.from("DRIVE-BYTES")]); }),
    streamExport: o.streamExport || (async (id, mime) => { calls.exports.push([id, mime]); return Readable.from([Buffer.from("EXPORT-BYTES")]); }),
  }));
  app.use("/app", webErrorHandler);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p, opts = {}) => fetch(base + p, { redirect: "manual", ...opts });
  const as = (n = SARA) => ({ cookie: cookieFor(n) });
  const json = (p, body, n = SARA, extra = {}) => call(p, {
    method: "POST", headers: { "content-type": "application/json", ...as(n), ...extra }, body: JSON.stringify(body),
  });
  const get = (p, n = SARA) => call(p, { headers: as(n) });
  const upload = (name, body, n = SARA, extra = {}) => call(`/app/api/upload?name=${encodeURIComponent(name)}`, {
    method: "POST", headers: { "content-type": "application/octet-stream", ...as(n), ...extra }, body,
  });
  return {
    base, call, get, json, upload, as, clock, conversations, webChannel, uploads, delivered, welcomes, calls, library, dir, db,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); }); }),
  };
}

async function withServer(o, fn) {
  const s = await serve(o);
  try { return await fn(s); } finally { await s.close(); }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await tick(5); }
  return false;
}

// ---- welcome and reading messages ----
test("an empty conversation gets the welcome once, even with polls at the same time", () => withServer({}, async (s) => {
  const polls = await Promise.all([1, 2, 3, 4, 5].map(() => s.get("/app/api/messages")));
  const bodies = await Promise.all(polls.map((r) => r.json()));
  assert.deepEqual(s.welcomes, [SARA]);
  for (const b of bodies) assert.deepEqual(b.messages.map((m) => m.body), ["WELCOME"]);
  const again = await (await s.get("/app/api/messages")).json();
  assert.equal(again.messages.length, 1);
  assert.deepEqual(s.welcomes, [SARA]);
}));

test("a person with history gets no welcome, and one person's welcome is not another's", () => withServer({}, async (s) => {
  s.conversations.append(SARA, "user", "text", "hello there");
  const sara = await (await s.get("/app/api/messages")).json();
  assert.deepEqual(sara.messages.map((m) => m.body), ["hello there"]);
  const omar = await (await s.get("/app/api/messages", OMAR)).json();
  assert.deepEqual(omar.messages.map((m) => m.body), ["WELCOME"]);
  assert.deepEqual(s.welcomes, [OMAR]);
}));

test("a failed welcome is logged, the poll still answers, and the next poll tries again", async () => {
  let n = 0;
  await withServer({ sendWelcome: async () => { n += 1; if (n === 1) throw new Error("sheet down"); } }, async (s) => {
    const first = await s.get("/app/api/messages");
    assert.equal(first.status, 200);
    assert.deepEqual((await first.json()).messages, []);
    await s.get("/app/api/messages");
    assert.equal(n, 2);
  });
});

test("with no seq the newest 200 come back oldest first; after a seq only newer ones", () => withServer({}, async (s) => {
  for (let i = 1; i <= 250; i++) s.conversations.append(SARA, i % 2 ? "user" : "bot", "text", `m${i}`);
  s.conversations.append(OMAR, "user", "text", "not yours");
  for (const url of ["/app/api/messages", "/app/api/messages?after=0", "/app/api/messages?after=abc"]) {
    const r = await (await s.get(url)).json();
    assert.equal(r.messages.length, 200, url);
    assert.equal(r.messages[0].body, "m51");
    assert.equal(r.messages[199].body, "m250");
    assert.ok(r.messages.every((m, i, a) => i === 0 || a[i - 1].seq < m.seq));
    assert.equal(r.busy, false);
  }
  const mid = (await (await s.get("/app/api/messages")).json()).messages[197].seq;
  const newer = await (await s.get(`/app/api/messages?after=${mid}`)).json();
  assert.deepEqual(newer.messages.map((m) => m.body), ["m249", "m250"]);
  const none = await (await s.get(`/app/api/messages?after=${mid + 1000}`)).json();
  assert.deepEqual(none, { messages: [], busy: false });
}));

test("message replies are never cached", () => withServer({}, async (s) => {
  s.conversations.append(SARA, "user", "text", "x");
  assert.equal((await s.get("/app/api/messages")).headers.get("cache-control"), "no-store");
}));

// ---- sending ----
test("text reaches deliverMessage as the signed-in number, in the webhook's message shape", () => withServer({}, async (s) => {
  const r = await s.json("/app/api/messages", { text: "  APMR catalogue  " });
  assert.equal(r.status, 202);
  const body = await r.json();
  assert.ok(Number.isInteger(body.seq));
  await until(() => s.delivered.length === 1);
  const { value, message, adapter } = s.delivered[0];
  assert.equal(adapter, s.webChannel);
  assert.deepEqual(value, { contacts: [{ profile: { name: "Sara" } }] });
  assert.equal(message.from, SARA);
  assert.equal(message.type, "text");
  assert.equal(message.text.body, "APMR catalogue");
  assert.match(message.id, /^web\./);
  assert.match(String(message.timestamp), /^\d+$/);
  const saved = s.conversations.since(SARA, 0);
  assert.deepEqual(saved.map((m) => [m.role, m.kind, m.body]), [["user", "text", "APMR catalogue"]]);
}));

test("a tap reaches deliverMessage as a button reply with its data, and its title is the person's message", () => withServer({}, async (s) => {
  const r = await s.json("/app/api/messages", { tapId: "menu|3", tapTitle: "Read a schedule", data: { rows: [1, 2] } }, OMAR);
  assert.equal(r.status, 202);
  await until(() => s.delivered.length === 1);
  const { message, value } = s.delivered[0];
  assert.equal(message.from, OMAR);
  assert.equal(message.type, "interactive");
  assert.deepEqual(message.interactive, {
    type: "button_reply",
    button_reply: { id: "menu|3", title: "Read a schedule", data: { rows: [1, 2] } },
  });
  assert.equal(value.contacts[0].profile.name, "Omar");
  assert.deepEqual(s.conversations.since(OMAR, 0).map((m) => m.body), ["Read a schedule"]);
  assert.deepEqual(s.conversations.since(SARA, 0), []);
}));

test("a tap without data has no data key", () => withServer({}, async (s) => {
  await s.json("/app/api/messages", { tapId: "saved|open", tapTitle: "Saved work" });
  await until(() => s.delivered.length === 1);
  assert.deepEqual(Object.keys(s.delivered[0].message.interactive.button_reply).sort(), ["id", "title"]);
}));

test("busy is true while the message is handled and false after", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await withServer({ deliverMessage: async () => { await gate; } }, async (s) => {
    assert.equal((await (await s.get("/app/api/messages")).json()).busy, false);
    await s.json("/app/api/messages", { text: "hi" });
    assert.equal((await (await s.get("/app/api/messages")).json()).busy, true);
    assert.equal((await (await s.get("/app/api/messages", OMAR)).json()).busy, false, "per person");
    release();
    assert.ok(await until(async () => (await (await s.get("/app/api/messages")).json()).busy === false));
  });
});

test("two messages in a row both count; busy stays true until the last settles", async () => {
  const gates = [];
  await withServer({ deliverMessage: () => new Promise((r) => gates.push(r)) }, async (s) => {
    await s.json("/app/api/messages", { text: "one" });
    await s.json("/app/api/messages", { text: "two" });
    gates[0]();
    await tick(30);
    assert.equal((await (await s.get("/app/api/messages")).json()).busy, true);
    gates[1]();
    assert.ok(await until(async () => (await (await s.get("/app/api/messages")).json()).busy === false));
  });
});

test("a failing deliverMessage is logged, never crashes, and busy clears", async () => {
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try {
    await withServer({ deliverMessage: async () => { throw new Error("handler blew up"); } }, async (s) => {
      const r = await s.json("/app/api/messages", { text: "secret words" });
      assert.equal(r.status, 202);
      assert.ok(await until(async () => (await (await s.get("/app/api/messages")).json()).busy === false));
      assert.ok(errs.some((e) => /handler blew up/.test(e)));
      assert.ok(!errs.some((e) => /secret words/.test(e)), "the message text is not logged");
    });
  } finally { console.error = orig; }
});

test("a deliverMessage that throws synchronously is handled the same way", async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    await withServer({ deliverMessage: () => { throw new Error("sync"); } }, async (s) => {
      assert.equal((await s.json("/app/api/messages", { text: "hi" })).status, 202);
      assert.ok(await until(async () => (await (await s.get("/app/api/messages")).json()).busy === false));
    });
  } finally { console.error = orig; }
});

test("a blank message or one over 4000 characters gets 400", () => withServer({}, async (s) => {
  for (const body of [{}, { text: "" }, { text: "   \n " }, { text: 5 }, { text: "x".repeat(4001) }, { tapId: "a" }, { tapId: "", tapTitle: "x" },
    { tapId: "a", tapTitle: "" }, { tapId: 7, tapTitle: "x" }, { tapId: "a".repeat(300), tapTitle: "x" }, { tapId: "a", tapTitle: "x".repeat(300) },
    { tapId: "a", tapTitle: "x", data: "y".repeat(5000) }, [], null, "text"]) {
    const r = await s.json("/app/api/messages", body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(typeof (await r.json()).error, "string");
  }
  assert.equal((await s.json("/app/api/messages", { text: "x".repeat(4000) })).status, 202);
  assert.equal(s.conversations.since(SARA, 0).length, 1, "refused messages are not saved");
}));

test("JSON endpoints need Content-Type: application/json, and a broken body is a clean 400", () => withServer({}, async (s) => {
  const plain = await s.call("/app/api/messages", { method: "POST", headers: { "content-type": "text/plain", ...s.as() }, body: '{"text":"hi"}' });
  assert.equal(plain.status, 415);
  const none = await s.call("/app/api/messages", { method: "POST", headers: s.as(), body: "{}" });
  assert.ok(none.status === 415 || none.status === 400);
  const broken = await s.call("/app/api/messages", { method: "POST", headers: { "content-type": "application/json", ...s.as() }, body: "{oops" });
  assert.equal(broken.status, 400);
  const text = await broken.text();
  assert.ok(!/at .*\.js/.test(text) && !text.includes("node_modules"), "no stack trace");
  assert.equal(s.delivered.length, 0);
}));

test("a POST from another site is refused", () => withServer({}, async (s) => {
  const r = await s.json("/app/api/messages", { text: "hi" }, SARA, { "sec-fetch-site": "cross-site" });
  assert.equal(r.status, 403);
  const o = await s.json("/app/api/messages", { text: "hi" }, SARA, { origin: "https://evil.example" });
  assert.equal(o.status, 403);
  const same = await s.json("/app/api/messages", { text: "hi" }, SARA, { "sec-fetch-site": "same-origin" });
  assert.equal(same.status, 202);
  assert.equal(s.conversations.since(SARA, 0).length, 1);
}));

test("/app with no session shows: Ask for your personal link to sign in.", () => withServer({}, async (s) => {
  const page = await s.call("/app/", { headers: { accept: "text/html" } });
  assert.equal(page.status, 401);
  assert.match(await page.text(), /Ask for your personal link to sign in\./);
  for (const [p, opts] of [["/app/api/messages", {}], ["/app/files/drive%3Aabc", {}], ["/app/api/share-link", { method: "POST" }], ["/app/api/upload?name=a.pdf", { method: "POST" }]]) {
    const r = await s.call(p, opts);
    assert.equal(r.status, 401, p);
    assert.deepEqual(await r.json(), { error: "Ask for your personal link to sign in." });
  }
}));

// ---- uploads ----
test("a 33 MB upload gets 413 with: That file is too large. The limit is 32 MB.", () => withServer({}, async (s) => {
  const r = await s.upload("big.pdf", Buffer.alloc(33 * MB, 0x25));
  assert.equal(r.status, 413);
  assert.deepEqual(await r.json(), { error: TOO_LARGE });
  assert.equal(s.delivered.length, 0);
  assert.equal(s.conversations.since(SARA, 0).length, 0);
  assert.equal(s.uploads.has(SARA), false);
}));

test("an oversized upload with no Content-Length (chunked) is also stopped at the limit", () => withServer({}, async (s) => {
  let i = 0;
  const body = new ReadableStream({ pull(c) { if (i++ < 34) c.enqueue(new Uint8Array(MB)); else c.close(); } });
  const r = await s.call("/app/api/upload?name=big.pdf", { method: "POST", headers: { "content-type": "application/pdf", ...s.as() }, body, duplex: "half" });
  assert.equal(r.status, 413);
  assert.deepEqual(await r.json(), { error: TOO_LARGE });
  assert.equal(s.uploads.has(SARA), false);
}));

test("a file of exactly 32 MB is accepted", () => withServer({}, async (s) => {
  const big = Buffer.concat([PDF, Buffer.alloc(32 * MB - PDF.length)]);
  assert.equal(big.length, 32 * MB);
  const r = await s.upload("max.pdf", big);
  assert.equal(r.status, 202);
}));

test("a .zip or unconverted HEIC upload gets 415 with: Send a photo, PDF or Excel file.", () => withServer({}, async (s) => {
  for (const [name, bytes] of [["notes.zip", ZIP], ["photo.heic", HEIC], ["photo.HEIF", HEIC], ["a.docx", ZIP], ["noext", PDF], ["a.html", Buffer.from("<html>")],
    ["a.svg", Buffer.from("<svg>")], ["a.exe", Buffer.from("MZ")]]) {
    const r = await s.upload(name, bytes);
    assert.equal(r.status, 415, name);
    assert.deepEqual(await r.json(), { error: BAD_TYPE });
  }
  assert.equal(s.delivered.length, 0);
}));

test("the type must match the bytes: wrong magic numbers are refused", () => withServer({}, async (s) => {
  const cases = [
    ["a.pdf", JPEG], ["a.jpg", PDF], ["a.png", JPEG], ["a.webp", PNG], ["a.xlsx", ZIP], ["a.xlsx", PDF],
    ["a.xls", XLSX], ["a.csv", Buffer.from([0x61, 0x2c, 0x00, 0x62])], ["a.jpeg", HEIC], ["a.pdf", Buffer.from("")],
  ];
  for (const [name, bytes] of cases) {
    const r = await s.upload(name, bytes.length ? bytes : Buffer.alloc(0));
    assert.equal(r.status, 415, name);
  }
}));

test("a photo goes to deliverMessage as an image, a PDF or sheet as a document, and the upload id reaches downloadMedia", async () => {
  const fetched = [];
  const deliverMessage = async (value, message, adapter) => {
    const id = (message.image || message.document).id;
    fetched.push({ message, got: await adapter.downloadMedia(id) });
  };
  await withServer({ deliverMessage }, async (s) => {
    const cases = [
      ["Floor plan.JPG", JPEG, "image", "image/jpeg"], ["a.jpeg", JPEG, "image", "image/jpeg"], ["a.png", PNG, "image", "image/png"], ["a.webp", WEBP, "image", "image/webp"],
      ["Schedule.pdf", PDF, "document", "application/pdf"],
      ["rows.xlsx", XLSX, "document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["old.xls", XLS, "document", "application/vnd.ms-excel"],
      ["rows.csv", Buffer.from("a,b\n1,2\n"), "document", "text/csv"],
    ];
    for (const [name, bytes, type, mime] of cases) {
      const r = await s.upload(name, bytes);
      assert.equal(r.status, 202, name);
      assert.ok(await until(() => fetched.length === 1 && s.uploads.has(SARA) === false), `${name} handled and removed`);
      const { message, got } = fetched.pop();
      assert.equal(message.from, SARA);
      assert.equal(message.type, type);
      assert.match(message.id, /^web\./);
      const media = message[type];
      assert.equal(media.mime_type, mime);
      assert.match(media.id, /^[0-9a-f-]{36}$/);
      if (type === "document") assert.equal(media.filename, name);
      assert.ok(Buffer.isBuffer(got.buffer) && got.buffer.equals(bytes), "downloadMedia returned the uploaded bytes");
      assert.equal(got.mediaType, mime);
    }
    // the person's message is the file name
    assert.deepEqual(s.conversations.since(SARA, 0).map((m) => m.body), cases.map((c) => c[0]));
  });
});

test("the uploaded file is gone from memory once the message is handled, and a stale id is not found", async () => {
  let id;
  await withServer({ deliverMessage: async (v, m) => { id = m.document.id; } }, async (s) => {
    await s.upload("a.pdf", PDF);
    assert.ok(await until(() => id && !s.uploads.has(SARA)));
    assert.equal(s.uploads.get(id), null);
    await assert.rejects(() => s.webChannel.downloadMedia(id), /not found/i);
  });
});

test("the file is kept while the message is still being handled", async () => {
  let release, id;
  const gate = new Promise((r) => { release = r; });
  await withServer({ deliverMessage: async (v, m) => { id = m.document.id; await gate; } }, async (s) => {
    await s.upload("a.pdf", PDF);
    await until(() => id);
    assert.equal(s.uploads.has(SARA), true);
    assert.ok(s.uploads.get(id));
    // a second file while the first is still waiting is refused, so a queued message never loses its file
    const second = await s.upload("b.pdf", PDF);
    assert.equal(second.status, 409);
    assert.ok(s.uploads.get(id), "the first upload is untouched");
    release();
    assert.ok(await until(() => !s.uploads.has(SARA)));
    assert.equal((await s.upload("b.pdf", PDF)).status, 202);
  });
});

test("two files arriving at once from one person: one is taken, the other refused", () => withServer({}, async (s) => {
  const big = Buffer.concat([PDF, Buffer.alloc(8 * MB)]);
  const results = await Promise.all([s.upload("a.pdf", big), s.upload("b.pdf", big)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [202, 409]);
  assert.equal(s.delivered.length, 1);
}));

test("uploads keep to one per person; another person has their own", async () => {
  const gate = new Promise(() => {});
  await withServer({ deliverMessage: () => gate }, async (s) => {
    assert.equal((await s.upload("a.pdf", PDF, SARA)).status, 202);
    assert.equal((await s.upload("a.pdf", PDF, OMAR)).status, 202);
    assert.equal(s.uploads.has(SARA), true);
    assert.equal(s.uploads.has(OMAR), true);
  });
});

test("an upload kept for 15 minutes is dropped after that, and the person can send again", async () => {
  const gate = new Promise(() => {});
  let id;
  await withServer({ deliverMessage: async (v, m) => { id = m.document.id; await gate; } }, async (s) => {
    assert.equal((await s.upload("a.pdf", PDF)).status, 202);
    await until(() => id);
    s.clock.t += 14 * 60 * 1000;
    assert.ok(s.uploads.get(id));
    s.clock.t += 61 * 1000;
    assert.equal(s.uploads.get(id), null);
    assert.equal(s.uploads.has(SARA), false);
    assert.equal((await s.upload("c.pdf", PDF)).status, 202);
  });
});

test("the upload store: put, get, remove, one per person, expiry", () => {
  let t = 1000;
  const store = createUploadStore({ now: () => t });
  const id = store.put("u1", { buffer: Buffer.from("x"), mediaType: "application/pdf", name: "a.pdf" });
  assert.deepEqual(store.get(id), { buffer: Buffer.from("x"), mediaType: "application/pdf" });
  assert.equal(store.has("u1"), true);
  assert.equal(store.has("u2"), false);
  store.remove(id);
  assert.equal(store.get(id), null);
  assert.equal(store.has("u1"), false);
  const a = store.put("u1", { buffer: Buffer.from("1"), mediaType: "image/png", name: "a.png" });
  t += 15 * 60 * 1000 - 1;
  assert.ok(store.get(a));
  t += 2;
  assert.equal(store.get(a), null);
  assert.equal(store.get("nope"), null);
  assert.equal(store.get(undefined), null);
  store.remove("nope");
});

test("a hostile file name is cleaned before it is shown or passed on", () => withServer({}, async (s) => {
  const name = "..\\..\\evil/\u0000na\nme<>\".pdf";
  const r = await s.upload(name, PDF);
  assert.equal(r.status, 202);
  await until(() => s.delivered.length === 1);
  const fn = s.delivered[0].message.document.filename;
  assert.ok(!/[\\/\u0000-\u001f]/.test(fn), JSON.stringify(fn));
  assert.ok(fn.endsWith(".pdf"));
  assert.equal(s.conversations.since(SARA, 0)[0].body, fn);
  assert.ok(fn.length <= 120);
}));

test("an upload from another site is refused", () => withServer({}, async (s) => {
  const r = await s.upload("a.pdf", PDF, SARA, { "sec-fetch-site": "cross-site" });
  assert.equal(r.status, 403);
  assert.equal(s.uploads.has(SARA), false);
  assert.equal((await s.upload("a.pdf", PDF, SARA, { "sec-fetch-site": "same-origin" })).status, 202);
}));

test("upload with no name or no body is a 400", () => withServer({}, async (s) => {
  const r = await s.call("/app/api/upload", { method: "POST", headers: { "content-type": "application/pdf", ...s.as() }, body: PDF });
  assert.equal(r.status, 400);
}));

// ---- files ----
test("/files refuses a Drive id not in the library", () => withServer({}, async (s) => {
  s.library.set("known1", { id: "known1", name: "APMR.pdf", folder: "Catalogue" });
  const r = await s.get("/app/files/drive%3Aunknown1");
  assert.equal(r.status, 404);
  assert.equal(s.calls.drive.length, 0, "nothing was fetched from Drive");
  for (const bad of ["drive%3A", "drive%3A..%2F..%2Fx", "nothing", "gen%3Anot-a-uuid", "drive%3Aa%20b", "http%3A%2F%2Fevil", "drive%3A" + "a".repeat(200)]) {
    assert.equal((await s.get(`/app/files/${bad}`)).status, 404, bad);
  }
  assert.equal(s.calls.drive.length, 0);
}));

test("/files asks the library again before refusing: getFile gets the raw id", async () => {
  const seen = [];
  await withServer({ getFile: async (id) => { seen.push(id); return null; } }, async (s) => {
    await s.get("/app/files/drive%3Aabc_-1");
    assert.deepEqual(seen, ["abc_-1"]);
  });
});

test("a Drive file is sent with its library name and type", () => withServer({}, async (s) => {
  s.library.set("f1", { id: "f1", name: "APMR-A Catalogue.pdf", folder: "Catalogues", size: 11 });
  const r = await s.get("/app/files/drive%3Af1");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "DRIVE-BYTES");
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.equal(r.headers.get("content-length"), null, "the saved size may be stale, so it is never sent");
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="APMR-A Catalogue\.pdf"; filename\*=UTF-8''APMR-A%20Catalogue\.pdf$/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(s.calls.drive, ["f1"]);
}));

test("a Drive file is streamed to the person, not loaded whole", async () => {
  const up = gatedStream([Buffer.from("FIRST-"), Buffer.from("SECOND")]);
  await withServer({ streamDrive: async () => up }, async (s) => {
    s.library.set("big", { id: "big", name: "Big.pdf", folder: "x" });
    const r = await s.get("/app/files/drive%3Abig");
    assert.equal(r.status, 200);
    const reader = r.body.getReader();
    const first = await reader.read(); // arrives while the rest has not been produced
    assert.equal(Buffer.from(first.value).toString(), "FIRST-");
    assert.equal(up.readableEnded, false);
    up.release();
    let rest = "";
    for (let x = await reader.read(); !x.done; x = await reader.read()) rest += Buffer.from(x.value).toString();
    assert.equal(rest, "SECOND");
  });
});

test("a client that goes away destroys the Drive stream", async () => {
  const up = gatedStream([Buffer.from("A"), Buffer.from("B")]);
  await withServer({ streamDrive: async () => up }, async (s) => {
    s.library.set("big", { id: "big", name: "Big.pdf", folder: "x" });
    const ac = new AbortController();
    const r = await s.call("/app/files/drive%3Abig", { headers: s.as(), signal: ac.signal });
    await r.body.getReader().read();
    ac.abort();
    assert.ok(await until(() => up.destroyed), "upstream destroyed after the client left");
  });
});

test("a stream error after the headers ends the response without crashing the server", async () => {
  const up = gatedStream([Buffer.from("PART"), Buffer.from("never")]);
  await withServer({ streamDrive: async () => up }, async (s) => {
    s.library.set("f", { id: "f", name: "F.pdf", folder: "x" });
    const r = await s.get("/app/files/drive%3Af");
    assert.equal(r.status, 200);
    const reader = r.body.getReader();
    await reader.read();
    const orig = console.error; console.error = () => {};
    up.destroy(new Error("upstream died"));
    await assert.rejects(async () => { for (;;) { const x = await reader.read(); if (x.done) break; } });
    console.error = orig;
    // the server still answers
    assert.equal((await s.get("/app/api/messages")).status, 200);
  });
});

test("when Drive fails before sending anything the person gets a 502, not a hang", async () => {
  const orig = console.error; console.error = () => {};
  try {
    await withServer({ streamDrive: async () => { throw Object.assign(new Error("Drive 500"), { response: { status: 500 } }); } }, async (s) => {
      s.library.set("f", { id: "f", name: "F.pdf", folder: "x" });
      const r = await s.get("/app/files/drive%3Af");
      assert.equal(r.status, 502);
      assert.equal(typeof (await r.json()).error, "string");
    });
  } finally { console.error = orig; }
});

test("a native Google file is exported with the library's export type, streamed", () => withServer({}, async (s) => {
  const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  s.library.set("sheet1", { id: "sheet1", name: "FCU Coil Connection Sheet.xlsx", folder: "x", exportMime: mime });
  const r = await s.get("/app/files/drive%3Asheet1");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "EXPORT-BYTES");
  assert.equal(r.headers.get("content-type"), mime);
  assert.equal(r.headers.get("content-length"), null);
  assert.deepEqual(s.calls.exports, [["sheet1", mime]]);
  assert.deepEqual(s.calls.drive, []);
}));

function putGenerated(s, user, name, bytes) {
  const id = require("node:crypto").randomUUID();
  fs.mkdirSync(path.join(s.dir, "generated"), { recursive: true });
  fs.writeFileSync(path.join(s.dir, "generated", id), bytes);
  s.db.prepare("INSERT INTO generated_files (id, user, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, user, name, "application/octet-stream", bytes.length, T0);
  return id;
}

test("/files refuses another person's generated file, and sends your own from disk", () => withServer({}, async (s) => {
  const bytes = Buffer.alloc(300_000, 7);
  const id = putGenerated(s, SARA, "Submittal.pdf", bytes);
  const mine = await s.get(`/app/files/gen%3A${id}`);
  assert.equal(mine.status, 200);
  assert.ok(Buffer.from(await mine.arrayBuffer()).equals(bytes));
  assert.equal(mine.headers.get("content-type"), "application/pdf");
  assert.equal(mine.headers.get("content-length"), String(bytes.length));
  assert.match(mine.headers.get("content-disposition"), /^attachment; filename="Submittal\.pdf"/);
  assert.equal((await s.get(`/app/files/gen%3A${id}`, OMAR)).status, 404);
  assert.equal((await s.get(`/app/files/gen%3A${require("node:crypto").randomUUID()}`)).status, 404);
}));

test("a generated file whose bytes are gone is a 404", () => withServer({}, async (s) => {
  const id = putGenerated(s, SARA, "x.pdf", Buffer.from("x"));
  fs.rmSync(path.join(s.dir, "generated", id));
  assert.equal((await s.get(`/app/files/gen%3A${id}`)).status, 404);
}));

test("downloads are attachments; only pictures and PDFs may be inline, and HTML never is", () => withServer({}, async (s) => {
  const pdf = putGenerated(s, SARA, "a.pdf", PDF);
  const png = putGenerated(s, SARA, "a.png", PNG);
  const html = putGenerated(s, SARA, "page.html", Buffer.from("<script>alert(1)</script>"));
  const svg = putGenerated(s, SARA, "x.svg", Buffer.from("<svg onload=alert(1)>"));
  const xlsx = putGenerated(s, SARA, "x.xlsx", XLSX);
  const disp = async (id, q = "") => (await s.get(`/app/files/gen%3A${id}${q}`));
  assert.match((await disp(pdf)).headers.get("content-disposition"), /^attachment/);
  assert.match((await disp(pdf, "?inline=1")).headers.get("content-disposition"), /^inline/);
  assert.match((await disp(png, "?inline=1")).headers.get("content-disposition"), /^inline/);
  assert.equal((await disp(png, "?inline=1")).headers.get("content-type"), "image/png");
  for (const id of [html, svg, xlsx]) {
    const r = await disp(id, "?inline=1");
    assert.match(r.headers.get("content-disposition"), /^attachment/);
    assert.equal(r.headers.get("content-type"), id === xlsx ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/octet-stream");
  }
}));

test("a file name with a quote, a slash, Arabic text and a newline still makes a valid header", () => withServer({}, async (s) => {
  const names = ['we"ird.pdf', "a/b\\c.pdf", "مخطط التكييف.pdf", "line\r\nbreak: x.pdf", "tab\there\u0000.pdf", "‮exe.fdp", "100%.pdf", "o'brien (1)*.pdf", "\ud800lone.pdf", ""];
  for (const name of names) {
    const id = putGenerated(s, SARA, name, PDF);
    const r = await s.get(`/app/files/gen%3A${id}`);
    assert.equal(r.status, 200, JSON.stringify(name));
    const cd = r.headers.get("content-disposition");
    assert.ok(/^attachment; filename="[^"\\]*"; filename\*=UTF-8''[A-Za-z0-9._~%-]+$/.test(cd), cd);
    assert.ok(!/[\r\n]/.test(cd));
    await r.arrayBuffer();
  }
  const arabic = putGenerated(s, SARA, "مخطط التكييف.pdf", PDF);
  const cd = (await s.get(`/app/files/gen%3A${arabic}`)).headers.get("content-disposition");
  const star = /filename\*=UTF-8''(.+)$/.exec(cd)[1];
  assert.equal(decodeURIComponent(star), "مخطط التكييف.pdf");
  assert.match(cd, /filename="[\x20-\x7e]+"/);
}));

test("contentDisposition builds both parts, strips controls and path parts, and never throws", () => {
  assert.equal(contentDisposition("a.pdf"), `attachment; filename="a.pdf"; filename*=UTF-8''a.pdf`);
  assert.equal(contentDisposition("a.pdf", true), `inline; filename="a.pdf"; filename*=UTF-8''a.pdf`);
  const nasty = contentDisposition('..\\..\\x/y"\r\nSet-Cookie: a=b.pdf');
  assert.ok(!/[\r\n\\]/.test(nasty.replace(/filename="[^"]*"/, "")), nasty);
  assert.ok(!nasty.includes("/"));
  for (const bad of [undefined, null, 5, "", " ", "\u0000", "\ud83d", "x".repeat(1000), { toString() { throw new Error("no"); } }]) {
    const v = contentDisposition(bad);
    assert.match(v, /^attachment; filename="[^"]*"; filename\*=UTF-8''[A-Za-z0-9._~%-]+$/);
    assert.doesNotThrow(() => require("node:http").validateHeaderValue("content-disposition", v));
  }
});

test("responses carry a same-origin CSP and nosniff", () => withServer({}, async (s) => {
  s.library.set("f1", { id: "f1", name: "a.pdf", folder: "x" });
  for (const r of [await s.get("/app/api/messages"), await s.get("/app/files/drive%3Af1"), await s.get("/app/files/drive%3Anope")]) {
    assert.equal(r.headers.get("content-security-policy"), CSP);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    await r.arrayBuffer();
  }
  const share = await s.json("/app/api/share-link", { ref: "drive:f1" });
  const { url } = await share.json();
  const pub = await s.call(new URL(url).pathname);
  assert.equal(pub.headers.get("content-security-policy"), CSP);
  assert.equal(pub.headers.get("x-content-type-options"), "nosniff");
  const gone = await s.call("/s/garbage");
  assert.equal(gone.headers.get("content-security-policy"), CSP);
  assert.equal(gone.headers.get("x-content-type-options"), "nosniff");
}));

// ---- share links ----
test("a share link is made for a file you can read, as a signed URL on PUBLIC_URL", () => withServer({}, async (s) => {
  s.library.set("f1", { id: "f1", name: "Cat.pdf", folder: "x" });
  const r = await s.json("/app/api/share-link", { ref: "drive:f1" });
  assert.equal(r.status, 200);
  const { url } = await r.json();
  assert.match(url, /^https:\/\/bot\.example\.test\/s\/[A-Za-z0-9_.-]+$/);
  const token = url.split("/s/")[1];
  assert.deepEqual(verifyShareToken(token, { secret: SECRET, now: T0 }), { ref: "drive:f1", owner: null });
  assert.equal(verifyShareToken(token, { secret: OTHER_SECRET, now: T0 }), null);
  assert.equal(verifyShareToken(token, { secret: SECRET, now: T0 + 8 * DAY }), null);
}));

test("share-link refuses what you cannot read, and bad input", () => withServer({}, async (s) => {
  s.library.set("f1", { id: "f1", name: "Cat.pdf", folder: "x" });
  const theirs = putGenerated(s, OMAR, "o.pdf", PDF);
  for (const ref of ["drive:nope", `gen:${theirs}`, "gen:" + require("node:crypto").randomUUID(), "junk", "drive:", ""]) {
    assert.equal((await s.json("/app/api/share-link", { ref })).status, 404, ref);
  }
  for (const body of [{}, { ref: 5 }, [], null]) assert.equal((await s.json("/app/api/share-link", body)).status, 400);
  const plain = await s.call("/app/api/share-link", { method: "POST", headers: { "content-type": "text/plain", ...s.as() }, body: '{"ref":"drive:f1"}' });
  assert.equal(plain.status, 415);
}));

test("share-link says so when PUBLIC_URL is not set", async () => {
  // a server with no publicUrl
  const clock = () => T0;
  const db = openDb(":memory:");
  const conversations = createConversations({ db, now: clock });
  const app = express();
  app.use(express.json());
  mountWeb(app, { secret: SECRET, getAccounts: async () => accounts(), now: clock });
  app.use(createWebRoutes({ deliverMessage: async () => {}, conversations, webChannel: {}, getFile: async () => ({ id: "f", name: "a.pdf" }), secret: SECRET, now: clock, uploads: createUploadStore({ now: clock }) }));
  const server = await new Promise((resolve) => { const x = app.listen(0, () => resolve(x)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/app/api/share-link`, { method: "POST", headers: { "content-type": "application/json", cookie: cookieFor() }, body: JSON.stringify({ ref: "drive:f" }) });
    assert.equal(r.status, 503);
  } finally { await new Promise((r) => server.close(r)); }
});

test("share links work without login and stop after 7 days", () => withServer({}, async (s) => {
  s.library.set("f1", { id: "f1", name: "Cat.pdf", folder: "x", size: 11 });
  const { url } = await (await s.json("/app/api/share-link", { ref: "drive:f1" })).json();
  const p = new URL(url).pathname;
  const ok = await s.call(p); // no cookie
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "DRIVE-BYTES");
  assert.match(ok.headers.get("content-disposition"), /^attachment; filename="Cat\.pdf"/);
  assert.equal(ok.headers.get("x-robots-tag"), "noindex");
  assert.equal(ok.headers.get("referrer-policy"), "no-referrer");
  assert.equal(ok.headers.get("cache-control"), "private");
  s.clock.t += 6 * DAY + 23 * 60 * 60 * 1000;
  assert.equal((await s.call(p)).status, 200);
  s.clock.t += 2 * 60 * 60 * 1000;
  const late = await s.call(p);
  assert.equal(late.status, 410);
  const page = await late.text();
  assert.match(page, /<html/);
  assert.ok(!page.includes("Cat.pdf") && !page.includes(p.split("/s/")[1]), "no detail");
  assert.equal(late.headers.get("x-robots-tag"), "noindex");
  assert.equal(late.headers.get("referrer-policy"), "no-referrer");
}));

test("a bad, edited or foreign share token is 410 with the same short page", () => withServer({}, async (s) => {
  s.library.set("f1", { id: "f1", name: "Cat.pdf", folder: "x" });
  const good = (await (await s.json("/app/api/share-link", { ref: "drive:f1" })).json()).url.split("/s/")[1];
  const other = makeShareToken("drive:f1", null, { secret: OTHER_SECRET, now: T0 });
  const session = makeSession(SARA, { secret: SECRET, now: T0 });
  const invite = makeInviteToken(SARA, { secret: SECRET, now: T0 });
  const pages = [];
  for (const t of ["garbage", good.slice(0, -3) + "abc", other, session, invite, "a.b", "%zz", "x".repeat(3000)]) {
    const r = await s.call(`/s/${encodeURIComponent(t)}`);
    assert.equal(r.status, 410, t.slice(0, 20));
    pages.push(await r.text());
  }
  assert.equal(new Set(pages).size, 1);
}));

test("a share token cannot sign anyone in, and a session cannot open /s", () => withServer({}, async (s) => {
  s.library.set("f1", { id: "f1", name: "Cat.pdf", folder: "x" });
  const token = makeShareToken("drive:f1", null, { secret: SECRET, now: T0 });
  const asCookie = await s.call("/app/api/messages", { headers: { cookie: `hv_session=${token}` } });
  assert.equal(asCookie.status, 401);
  const withSession = await s.call(`/s/${makeSession(SARA, { secret: SECRET, now: T0 })}`);
  assert.equal(withSession.status, 410);
}));

test("a shared Drive file removed from the library is a 404", () => withServer({}, async (s) => {
  s.library.set("f1", { id: "f1", name: "Cat.pdf", folder: "x" });
  const { url } = await (await s.json("/app/api/share-link", { ref: "drive:f1" })).json();
  s.library.delete("f1");
  const r = await s.call(new URL(url).pathname);
  assert.equal(r.status, 404);
  assert.equal(r.headers.get("x-robots-tag"), "noindex");
}));

test("a shared generated file is the owner's, streams from disk, and others cannot forge it", () => withServer({}, async (s) => {
  const bytes = Buffer.alloc(5000, 9);
  const id = putGenerated(s, SARA, "Selection.xlsx", bytes);
  const { url } = await (await s.json("/app/api/share-link", { ref: `gen:${id}` })).json();
  const ok = await s.call(new URL(url).pathname);
  assert.equal(ok.status, 200);
  assert.ok(Buffer.from(await ok.arrayBuffer()).equals(bytes));
  // a token claiming Omar owns Sara's file finds nothing
  const forged = makeShareToken(`gen:${id}`, OMAR, { secret: SECRET, now: T0 });
  assert.equal((await s.call(`/s/${forged}`)).status, 404);
  // a gen token with no owner finds nothing
  const noOwner = makeShareToken(`gen:${id}`, null, { secret: SECRET, now: T0 });
  assert.equal((await s.call(`/s/${noOwner}`)).status, 404);
}));

test("a share token holds the ref and the owner, expires after 7 days and has its own purpose", () => {
  const t = makeShareToken("gen:abc", "97455551111", { secret: SECRET, now: T0 });
  assert.deepEqual(verifyShareToken(t, { secret: SECRET, now: T0 + 6 * DAY }), { ref: "gen:abc", owner: "97455551111" });
  assert.equal(verifyShareToken(t, { secret: SECRET, now: T0 + 7 * DAY + 1 }), null);
  assert.equal(verifyShareToken(makeInviteToken(SARA, { secret: SECRET, now: T0 }), { secret: SECRET, now: T0 }), null);
  assert.throws(() => makeShareToken("drive:x", null, { secret: "short", now: T0 }));
  assert.equal(verifyShareToken(t, { secret: "short", now: T0 }), null);
  // an unpadded secret is treated the same as the trimmed one
  assert.ok(verifyShareToken(t, { secret: `  ${SECRET}\n`, now: T0 }));
});

test("a share link is never written to the log", async () => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => lines.push(a.join(" "));
  try {
    await withServer({}, async (s) => {
      s.library.set("f1", { id: "f1", name: "Cat.pdf", folder: "x" });
      const { url } = await (await s.json("/app/api/share-link", { ref: "drive:f1" })).json();
      const token = url.split("/s/")[1];
      await (await s.call(`/s/${token}`)).arrayBuffer();
      await (await s.call(`/s/${token}x`)).text();
      s.clock.t += 9 * DAY;
      await (await s.call(`/s/${token}`)).text();
      assert.ok(!lines.some((l) => l.includes(token)), "token found in logs");
    });
  } finally { Object.assign(console, orig); }
});

test("with no usable WEB_SECRET the share route is shut too", async () => {
  const clock = () => T0;
  const app = express();
  mountWeb(app, { secret: "short", getAccounts: async () => accounts(), now: clock });
  const db = openDb(":memory:");
  app.use(createWebRoutes({ deliverMessage: async () => {}, conversations: createConversations({ db, now: clock }), webChannel: {}, getFile: async () => ({ id: "f", name: "a.pdf" }), secret: "short", now: clock, uploads: createUploadStore({ now: clock }) }));
  const server = await new Promise((resolve) => { const x = app.listen(0, () => resolve(x)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/s/anything`);
    assert.equal(r.status, 410);
  } finally { await new Promise((r) => server.close(r)); }
});

test("the web routes make no database or network call when created", () => {
  const clock = () => T0;
  assert.doesNotThrow(() => createWebRoutes({ deliverMessage: async () => {}, conversations: {}, webChannel: {}, getFile: async () => null, secret: SECRET, now: clock, uploads: createUploadStore({ now: clock }) }));
});

test("a Drive file bigger than its saved library size is sent in full, by /files and by a share link", () => withServer({}, async (s) => {
  // the file was replaced in place in Drive: same id, more bytes than the saved record says
  s.library.set("f1", { id: "f1", name: "Replaced.pdf", folder: "x", size: 5 });
  const direct = await s.get("/app/files/drive%3Af1");
  assert.equal(direct.status, 200);
  assert.equal(await direct.text(), "DRIVE-BYTES");
  const { url } = await (await s.json("/app/api/share-link", { ref: "drive:f1" })).json();
  const shared = await s.call(new URL(url).pathname);
  assert.equal(shared.status, 200);
  assert.equal(await shared.text(), "DRIVE-BYTES");
  assert.equal(shared.headers.get("content-length"), null);
}));

// ---- the screen (web/public) ----
test("/app/ serves the chat page, with the strict policy and nosniff, to a signed-in person only", () => withServer({}, async (s) => {
  const anon = await s.call("/app/", { headers: { accept: "text/html" } });
  assert.equal(anon.status, 401);
  const r = await s.get("/app/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.equal(r.headers.get("content-security-policy"), CSP);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const html = await r.text();
  assert.match(html, /<title>HVAC Assistant<\/title>/);
  assert.doesNotMatch(html, /Mannai/i);
  assert.match(html, /<link rel="manifest"[^>]*crossorigin="use-credentials"/);
}));

test("the page's files are served with the policy; the page has no inline script or style", () => withServer({}, async (s) => {
  const html = await (await s.get("/app/")).text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /<style/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  for (const [p, type] of [
    ["/app/app.js", /javascript/], ["/app/render.js", /javascript/], ["/app/styles.css", /text\/css/],
    ["/app/manifest.webmanifest", /manifest\+json|json/], ["/app/icon-192.png", /image\/png/], ["/app/icon-512.png", /image\/png/],
  ]) {
    const r = await s.get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get("content-type"), type, p);
    assert.equal(r.headers.get("content-security-policy"), CSP, p);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", p);
    if (!/png/.test(p)) assert.doesNotMatch(await r.text(), /Mannai/i, p);
  }
  const css = await (await s.get("/app/styles.css")).text();
  assert.match(css, /100dvh/);
  assert.match(css, /prefers-color-scheme:\s*dark/);
  assert.match(css, /font-size:\s*16px/);
}));

test("the files behind the sign-in: nobody gets styles, scripts or the manifest without it", () => withServer({}, async (s) => {
  for (const p of ["/app/app.js", "/app/render.js", "/app/styles.css", "/app/manifest.webmanifest", "/app/icon-192.png"]) {
    assert.equal((await s.call(p)).status, 401, p);
  }
}));

test("the temporary sharing test page is not served under /app, and there is no directory listing", () => withServer({}, async (s) => {
  for (const p of ["/app/share-test.html", "/app/SHARE-TEST.HTML", "/app/share-test.html/", "/app/%73hare-test.html"]) {
    assert.equal((await s.get(p)).status, 404, p);
  }
  const bare = await s.get("/app");
  assert.ok([301, 302, 308].includes(bare.status), "a bare /app goes to /app/");
  assert.equal(bare.headers.get("location"), "/app/");
  assert.equal((await s.get("/app/..%2Fweb%2Froutes.js")).status === 200, false);
  assert.equal((await s.get("/app/%2e%2e/routes.js")).status === 200, false);
  const missing = await s.get("/app/nothing-here.js");
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /Index of|<ul>/);
}));

test("the schedule table's tap may carry a long table; other taps still carry little", () => withServer({}, async (s) => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, tag: `Room ${i} `.padEnd(60, "x"), type: "split", value: 24000, unit: "BTU/h", qty: 2 }));
  const size = JSON.stringify({ rows }).length;
  assert.ok(size > 20000 && size < 60000, String(size));
  const ok = await s.json("/app/api/messages", { tapId: "rows-ok", tapTitle: "Looks right", data: { rows } });
  assert.equal(ok.status, 202);
  await until(() => s.delivered.length === 1);
  assert.equal(s.delivered[0].message.interactive.button_reply.data.rows.length, 200);
  const other = await s.json("/app/api/messages", { tapId: "menu|3", tapTitle: "x", data: { rows } });
  assert.equal(other.status, 400, "another tap keeps the small limit");
  const huge = await s.json("/app/api/messages", { tapId: "rows-ok", tapTitle: "Looks right", data: { rows: [...rows, ...rows, ...rows, ...rows] } });
  assert.ok(huge.status === 400 || huge.status === 413, `got ${huge.status}`);
}));
