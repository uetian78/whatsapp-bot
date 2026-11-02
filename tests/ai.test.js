const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDb } = require("../lib/db.js");
const credits = require("../lib/ai-credits.js");
const { createAi, textOf, costUsd, DEFAULT_MODEL, DEFAULT_CAP_USD } = require("../lib/ai.js");

const ROOT = path.join(__dirname, "..");
const JAN = Date.UTC(2026, 0, 15, 12, 0, 0);
const FEB = Date.UTC(2026, 1, 1, 0, 0, 0);

// A reply shaped like the SDK's Message. `usage` fields default to zero.
function reply({ text = "hello", stop_reason = "end_turn", usage = {}, content } = {}) {
  return {
    id: "msg_1", type: "message", role: "assistant", model: DEFAULT_MODEL, stop_reason,
    content: content || [{ type: "text", text }],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
  };
}

// A client whose messages.create returns (or throws) what the test queues.
function fakeClient(...results) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        const next = results.length > 1 ? results.shift() : results[0];
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

function setup({ client, now = () => JAN, capUsd = 10 } = {}) {
  credits.resetCredits();
  const db = openDb(":memory:");
  const c = client || fakeClient(reply());
  return { db, client: c, ai: createAi({ client: c, db, now, capUsd }) };
}

const usageRows = (db) => db.prepare("SELECT * FROM ai_usage ORDER BY rowid").all();

test("textOf skips thinking blocks", () => assert.equal(
  textOf({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: "hi" }] }), "hi"));

test("textOf copes with a missing message or content", () => {
  assert.equal(textOf(null), "");
  assert.equal(textOf({}), "");
  assert.equal(textOf({ content: [{ type: "thinking", thinking: "x" }] }), "");
});

test("the defaults are Haiku 5.5 and a 10 dollar cap", () => {
  assert.equal(DEFAULT_MODEL, "claude-haiku-5-5");
  assert.equal(DEFAULT_CAP_USD, 10);
});

test("cost uses the published rates", () => {
  // claude-haiku-5-5, 1M input and 1M output, costs 0.10 + 0.50 = 0.60
  const usage = { input_tokens: 1e6, output_tokens: 1e6 };
  assert.ok(Math.abs(costUsd("claude-haiku-5-5", usage) - 0.60) < 1e-9);
});

test("cache reads cost 0.1x input and 5-minute cache writes 1.25x", () => {
  const read = costUsd("claude-haiku-5-5", { cache_read_input_tokens: 1e6 });
  const write = costUsd("claude-haiku-5-5", { cache_creation_input_tokens: 1e6 });
  assert.ok(Math.abs(read - 0.01) < 1e-9);
  assert.ok(Math.abs(write - 0.125) < 1e-9);
});

test("a prompt over 100K tokens is billed at the long-prompt rate", () => {
  const usage = { input_tokens: 200000, output_tokens: 1e6 };
  // 0.2M * 0.50 + 1M * 2.50
  assert.ok(Math.abs(costUsd("claude-haiku-5-5", usage, true) - 2.6) < 1e-9);
  assert.ok(Math.abs(costUsd("claude-haiku-5-5", { input_tokens: 90000 }, true) - 0.009) < 1e-9, "under 100K stays on the base rate");
});

test("an unknown model is costed at the dearest rate, so the cap errs safe", () => {
  const unknown = costUsd("claude-made-up", { input_tokens: 1e6, output_tokens: 1e6 });
  assert.ok(unknown > costUsd("claude-haiku-5-5", { input_tokens: 1e6, output_tokens: 1e6 }) * 10);
});

test("missing or null usage counts as zero", () => {
  assert.equal(costUsd("claude-haiku-5-5", undefined), 0);
  assert.equal(costUsd("claude-haiku-5-5", { input_tokens: 5, cache_read_input_tokens: null }) > 0, true);
});

test("askText sends Haiku 5.5, effort low, no sampling params, and returns the text", async () => {
  const { ai, client } = setup({ client: fakeClient(reply({ text: "  Answer  " })) });
  const out = await ai.askText({ purpose: "test", system: "be brief", user: "question" });
  assert.equal(out, "Answer");
  const p = client.calls[0];
  assert.equal(p.model, "claude-haiku-5-5");
  assert.ok(p.max_tokens >= 1024);
  assert.deepEqual(p.output_config, { effort: "low" });
  assert.equal(p.system, "be brief");
  assert.deepEqual(p.messages, [{ role: "user", content: "question" }]);
  for (const k of ["temperature", "top_p", "top_k", "thinking"]) assert.equal(k in p, false, k);
});

test("a small maxTokens is raised to 1024 because thinking counts toward it", async () => {
  const { ai, client } = setup();
  await ai.askText({ purpose: "t", system: "s", user: "u", maxTokens: 30 });
  assert.equal(client.calls[0].max_tokens, 1024);
  await ai.askText({ purpose: "t", system: "s", user: "u", maxTokens: 4000, effort: "medium" });
  assert.equal(client.calls[1].max_tokens, 4000);
  assert.equal(client.calls[1].output_config.effort, "medium");
});

test("askMessage strips sampling params, keeps cached system blocks, and returns the message", async () => {
  const msg = reply({ text: "ok", usage: { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } });
  const { ai, client } = setup({ client: fakeClient(msg) });
  const system = [
    { type: "text", text: "static", cache_control: { type: "ephemeral" } },
    { type: "text", text: "dynamic" },
  ];
  const got = await ai.askMessage({
    purpose: "kb", system, messages: [{ role: "user", content: "q" }], max_tokens: 400, temperature: 0.2, top_p: 0.9,
  });
  assert.equal(got, msg);
  const p = client.calls[0];
  assert.deepEqual(p.system, system);
  assert.equal(p.max_tokens, 1024);
  for (const k of ["temperature", "top_p", "top_k", "purpose"]) assert.equal(k in p, false, k);
});

test("every answered call is recorded with its tokens and cost", async () => {
  const { ai, db } = setup({
    client: fakeClient(reply({ usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300 } })),
  });
  await ai.askText({ purpose: "askClaude", system: "s", user: "u" });
  const rows = usageRows(db);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.ts, JAN);
  assert.equal(r.purpose, "askClaude");
  assert.equal(r.model, "claude-haiku-5-5");
  assert.deepEqual([r.input, r.output, r.cache_read, r.cache_write], [1000, 200, 4000, 300]);
  const want = costUsd("claude-haiku-5-5", { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300 });
  assert.ok(Math.abs(r.cost_usd - want) < 1e-12);
  assert.ok(Math.abs(ai.spendThisMonth() - want) < 1e-12);
});

test("the monthly cap blocks calls, and a new month resets it", async () => {
  let t = JAN;
  const { ai, client, db } = setup({
    now: () => t, capUsd: 0.60,
    client: fakeClient(reply({ usage: { input_tokens: 1e6, output_tokens: 1e6 } })), // 0.60 a call
  });
  assert.equal(ai.available(), true);
  assert.equal(await ai.askText({ purpose: "t", system: "s", user: "u" }), "hello");
  assert.equal(ai.available(), false, "spent the whole cap");
  const before = client.calls.length;
  assert.equal(await ai.askText({ purpose: "t", system: "s", user: "u" }), null);
  assert.equal(await ai.askMessage({ purpose: "t", messages: [{ role: "user", content: "u" }] }), null);
  assert.equal(client.calls.length, before, "no request is sent over the cap");
  assert.equal(usageRows(db).length, 1);

  t = FEB; // first moment of the next UTC month
  assert.equal(ai.spendThisMonth(), 0);
  assert.equal(ai.available(), true);
  assert.equal(await ai.askText({ purpose: "t", system: "s", user: "u" }), "hello");
});

test("spendThisMonth counts the UTC calendar month of now, from its first to its last moment", () => {
  let t = JAN;
  const { ai, db } = setup({ now: () => t });
  const put = db.prepare("INSERT INTO ai_usage (ts, purpose, model, input, output, cache_read, cache_write, cost_usd) VALUES (?, 'x', 'm', 0, 0, 0, 0, ?)");
  put.run(Date.UTC(2025, 11, 31, 23, 59, 59, 999), 1);   // December: not counted
  put.run(Date.UTC(2026, 0, 1, 0, 0, 0, 0), 2);          // first moment of January
  put.run(Date.UTC(2026, 0, 31, 23, 59, 59, 999), 4);    // last moment of January
  put.run(Date.UTC(2026, 1, 1, 0, 0, 0, 0), 8);          // February: not counted
  assert.equal(ai.spendThisMonth(), 6);
  t = FEB;
  assert.equal(ai.spendThisMonth(), 8);
});

test("available() is false with no client (no API key) and never touches the database", () => {
  credits.resetCredits();
  let opened = 0;
  const ai = createAi({ client: null, db: () => { opened++; return openDb(":memory:"); }, capUsd: 10 });
  assert.equal(ai.available(), false);
  assert.equal(opened, 0);
});

test("the database is opened lazily, once, when a function is passed", async () => {
  credits.resetCredits();
  let opened = 0;
  const ai = createAi({ client: fakeClient(reply()), db: () => { opened++; return openDb(":memory:"); }, now: () => JAN, capUsd: 10 });
  assert.equal(opened, 0);
  assert.equal(ai.available(), true);
  await ai.askText({ purpose: "t", system: "s", user: "u" });
  assert.equal(opened, 1);
});

test("available() is false while the credit latch is set", () => {
  const { ai } = setup();
  assert.equal(ai.available(), true);
  credits.markExhausted();
  assert.equal(ai.available(), false);
  credits.resetCredits();
});

test("a credit error returns null and sets the credit latch", async () => {
  const err = new Error("400 Your credit balance is too low to access the Anthropic API.");
  err.status = 400;
  const { ai } = setup({ client: fakeClient(err) });
  assert.equal(await ai.askText({ purpose: "t", system: "s", user: "u" }), null);
  assert.equal(credits.isExhausted(), true);
  assert.equal(ai.available(), false);
  credits.resetCredits();
});

test("refusal, max_tokens with no text, and API errors return null without throwing", async () => {
  const boom = Object.assign(new Error("socket hang up"), { status: 500 });
  const cases = [
    reply({ stop_reason: "refusal", content: [], usage: { input_tokens: 10 } }),
    reply({ stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "" }], usage: { output_tokens: 1024 } }),
    reply({ stop_reason: "max_tokens", content: [], usage: { output_tokens: 1024 } }),
    boom,
  ];
  for (const c of cases) {
    const { ai } = setup({ client: fakeClient(c) });
    assert.equal(await ai.askText({ purpose: "t", system: "s", user: "u" }), null);
    const { ai: ai2 } = setup({ client: fakeClient(c) });
    assert.equal(await ai2.askMessage({ purpose: "t", messages: [{ role: "user", content: "u" }] }), null);
  }
});

test("a refusal or truncated reply is still billed, an API error is not", async () => {
  const refusal = setup({ client: fakeClient(reply({ stop_reason: "refusal", content: [], usage: { input_tokens: 500 } })) });
  await refusal.ai.askText({ purpose: "t", system: "s", user: "u" });
  assert.equal(usageRows(refusal.db).length, 1);
  const failed = setup({ client: fakeClient(new Error("down")) });
  await failed.ai.askText({ purpose: "t", system: "s", user: "u" });
  assert.equal(usageRows(failed.db).length, 0);
});

test("max_tokens with some text still returns the text", async () => {
  const { ai } = setup({ client: fakeClient(reply({ stop_reason: "max_tokens", text: "partial" })) });
  assert.equal(await ai.askText({ purpose: "t", system: "s", user: "u" }), "partial");
});

test("errors are logged by purpose, model and error type, never the text", async () => {
  const secret = "SECRET DOCUMENT TEXT 4711";
  const err = Object.assign(new Error(`bad request: ${secret}`), { status: 400, name: "BadRequestError" });
  const { ai } = setup({ client: fakeClient(err) });
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.map(String).join(" "));
  try { await ai.askText({ purpose: "aiGuidance", system: "s", user: secret }); }
  finally { console.error = real; }
  const logged = lines.join("\n");
  assert.match(logged, /aiGuidance/);
  assert.match(logged, /claude-haiku-5-5/);
  assert.match(logged, /BadRequestError/);
  assert.doesNotMatch(logged, /SECRET/);
});

test("a call over 100K prompt tokens is recorded at the long-prompt rate", async () => {
  const { ai, db } = setup({ client: fakeClient(reply({ usage: { input_tokens: 200000, output_tokens: 0 } })) });
  await ai.askText({ purpose: "t", system: "s", user: "u" });
  assert.ok(Math.abs(usageRows(db)[0].cost_usd - 0.1) < 1e-9); // 0.2M * 0.50
});

test("an unreadable usage table switches AI off instead of throwing", async () => {
  const { ai, client, db } = setup();
  db.exec("DROP TABLE ai_usage");
  const real = console.error;
  console.error = () => {};
  try {
    assert.equal(ai.available(), false);
    assert.equal(await ai.askText({ purpose: "t", system: "s", user: "u" }), null);
  } finally { console.error = real; }
  assert.equal(client.calls.length, 0);
});

test("a failing usage write never breaks the answer", async () => {
  const { ai, db } = setup();
  db.exec("CREATE TRIGGER no_insert BEFORE INSERT ON ai_usage BEGIN SELECT RAISE(ABORT, 'no'); END");
  const real = console.error;
  console.error = () => {};
  try { assert.equal(await ai.askText({ purpose: "t", system: "s", user: "u" }), "hello"); }
  finally { console.error = real; }
});

// ---- plan gating is gone ----
test("no plan gating remains: aiAllowed and freePlanMessage are gone", () => {
  const accounts = require("../lib/accounts.js");
  assert.equal("aiAllowed" in accounts, false);
  assert.equal("freePlanMessage" in accounts, false);
  const gone = ["aiAllowed", "freePlanMessage", "aiSearchConsented", "aiask", "aiok", "aiyes", "aino", "creditsExhaustedMessage"];
  const files = ["server.js", ...fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js")).map((f) => path.join("lib", f))];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const word of gone) assert.equal(src.includes(word), false, `${word} still in ${f}`);
  }
});

test("the no-AI message never mentions a PAID plan or credits", () => {
  const msgs = [
    credits.aiPausedMessage(),
  ];
  for (const m of msgs) {
    assert.doesNotMatch(m, /paid|plan|credit|upgrade|premium|free/i, m);
  }
});

test("the no-AI message uses the agreed wording, with no greeting or name", () => {
  assert.equal(credits.aiPausedMessage(),
    "I couldn't find a document for that, and AI file finding is paused right now. You can still get any document by its name.");
});

// ---- a stale "Search with AI?" tap from an old message ----
const { createHarness, fixturesExist } = require("./replay/harness.js");
const skipHarness = !fixturesExist() && "replay fixtures not found (run tests/replay/export-log.js)";

test("a stale aiyes tap from an old message gets a friendly reply and does not crash", { skip: skipHarness }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvac-ai-"));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const h = createHarness(async (value, message) => {
    if (message.text && message.text.body === "STALE-TAP") {
      delete message.text;
      message.type = "interactive";
      message.interactive = { type: "button_reply", button_reply: { id: "aiyes", title: "Yes, search with AI" } };
    }
    const { deliverMessage } = require("../server.js");
    const { whatsappAdapter } = require("../lib/channel-whatsapp.js");
    await deliverMessage(value, message, whatsappAdapter);
  });
  try {
    const out = await h.send("100000001", "STALE-TAP");
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "text");
    assert.doesNotMatch(out[0].text, /something went wrong/i);
    assert.match(out[0].text, /menu/i);
    assert.equal(h.stats.errors, 0, [...h.stats.errorSamples].join("; "));
  } finally {
    try { require("../lib/db.js").closeDb(); } catch (_) { /* never opened */ }
    h.close();
    if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the bot end to end, with a fake Anthropic client ----
// A miss on both the name and the free scan now runs AI search by itself, with
// no "Search with AI?" question, until the monthly cap is reached.
function withFakeAnthropic(capUsd, run) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvac-ai-e2e-"));
    const saved = { DATA_DIR: process.env.DATA_DIR, AI_MONTHLY_CAP_USD: process.env.AI_MONTHLY_CAP_USD };
    const sdkId = require.resolve("@anthropic-ai/sdk");
    const realSdk = require.cache[sdkId];
    const calls = [];
    function FakeAnthropic() {
      this.messages = {
        create: async (p) => {
          calls.push(p);
          const guidance = String(p.system).includes("A customer's message did NOT match");
          return reply({ text: guidance ? "SHOW_MENU" : "0", usage: { input_tokens: 1000, output_tokens: 10 } });
        },
      };
    }
    process.env.DATA_DIR = dir;
    process.env.AI_MONTHLY_CAP_USD = String(capUsd);
    const h = createHarness(async (value, message) => {
      const { deliverMessage } = require("../server.js");
      const { whatsappAdapter } = require("../lib/channel-whatsapp.js");
      await deliverMessage(value, message, whatsappAdapter);
    });
    process.env.ANTHROPIC_API_KEY = "test-key"; // createHarness blanked it; server.js reads it on first require
    require.cache[sdkId] = Object.assign(new (require("module"))(sdkId), { filename: sdkId, loaded: true, exports: FakeAnthropic });
    try {
      await run({ h, calls });
    } finally {
      try { require("../lib/db.js").closeDb(); } catch (_) { /* never opened */ }
      if (realSdk) require.cache[sdkId] = realSdk; else delete require.cache[sdkId];
      h.close();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const allText = (out) => out.map((o) => o.text || "").join("\n");

test("a miss runs AI search by itself, with no permission question", { skip: skipHarness }, withFakeAnthropic(10, async ({ h, calls }) => {
  const out = await h.send("100000001", "qzxwvk");
  const text = allText(out);
  assert.ok(calls.length >= 1, "AI was called");
  assert.ok(calls.every((c) => c.model === "claude-haiku-5-5" && c.max_tokens >= 1024 && c.output_config.effort === "low"));
  assert.doesNotMatch(text, /Shall I search with AI|Yes, search with AI|No thanks|FREE|PAID|credit/i);
  assert.match(text, /Even AI couldn't find anything matching/);
  assert.match(text, /Request it/);
}));

test("over the monthly cap, a miss says AI is paused and sends nothing to the API", { skip: skipHarness }, withFakeAnthropic(0, async ({ h, calls }) => {
  const out = await h.send("100000001", "qzxwvk");
  assert.equal(calls.length, 0);
  assert.match(allText(out), /AI file finding is paused right now\. You can still get any document by its name\./);
}));

// A series that misses the map and the prefix matcher must not cost an AI call
// of its own: the free ranked scan runs first (in sendNotFoundWithSuggestions),
// and AI search only after that.
test("a series miss makes no AI call before the free scan", { skip: skipHarness }, withFakeAnthropic(10, async ({ h, calls }) => {
  // Make createHarness's modules load with the key set, then call the resolver directly.
  await h.send("100000001", "hi");
  const { resolveSeriesFile } = require("../server.js");
  const files = [{ id: "f1", name: "Totally Unrelated.pdf", folder: "Catalogues" }];
  const found = await resolveSeriesFile("ZZQXW", "Catalogue", async () => files);
  assert.equal(found, null);
  assert.equal(calls.length, 0, "no AI call from the series resolver");
}));
