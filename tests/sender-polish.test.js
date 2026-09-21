const test = require("node:test");
const assert = require("node:assert");
const { buildPolishRequest, polishDraft, POLISH_MODEL } = require("../lib/sender-polish.js");

test("request uses Haiku with a bounded reply", () => {
  const req = buildPolishRequest({ text: "hi", language: "en" });
  assert.equal(req.model, "claude-haiku-4-5-20251001");
  assert.equal(POLISH_MODEL, req.model);
  assert.equal(req.max_tokens, 600);
});

test("English vs Arabic is stated in the system prompt", () => {
  assert.match(buildPolishRequest({ text: "x", language: "en" }).system, /in English/);
  assert.match(buildPolishRequest({ text: "x", language: "ar" }).system, /in Arabic/);
});

test("user note is passed verbatim; instruction only when given", () => {
  const plain = buildPolishRequest({ text: "submittal ready", language: "en" });
  assert.equal(plain.messages.length, 1);
  assert.match(plain.messages[0].content, /submittal ready/);
  assert.doesNotMatch(plain.messages[0].content, /Extra instruction/);

  const withInstr = buildPolishRequest({ text: "submittal ready", language: "en", instruction: "shorter" });
  assert.match(withInstr.messages[0].content, /Extra instruction: shorter/);
});

test("polishDraft returns the joined, trimmed text blocks", async () => {
  let seen;
  const fake = { messages: { create: async (p) => { seen = p; return { content: [{ type: "text", text: "  Hello Ahmed.  " }] }; } } };
  const out = await polishDraft(fake, { text: "tell ahmed hello", language: "en" });
  assert.equal(out, "Hello Ahmed.");
  assert.equal(seen.model, POLISH_MODEL);
});

test("polishDraft propagates SDK errors (caller decides credit handling)", async () => {
  const fake = { messages: { create: async () => { throw Object.assign(new Error("boom"), { status: 500 }); } } };
  await assert.rejects(polishDraft(fake, { text: "x", language: "en" }), /boom/);
});
