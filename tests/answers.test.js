const test = require("node:test");
const assert = require("node:assert");
const { answerFromLibrary, formatAnswer, formatPageHits, libraryQuery, MAX_PAGES, MAX_PAGE_CHARS } = require("../lib/answers.js");
const { PRODUCT_KB } = require("../product-facts.js");

// A reply shaped like the SDK's Message.
const message = (content, stop_reason = "end_turn") => ({
  id: "msg_1", type: "message", role: "assistant", stop_reason, content,
  usage: { input_tokens: 1, output_tokens: 1 },
});
const cite = (document_index, cited_text = "x") => ({
  type: "char_location", cited_text, document_index, document_title: "t", start_char_index: 0, end_char_index: 1,
});

// An AI whose askMessage records its params and returns what the test gives.
function fakeAi(reply, { available = true } = {}) {
  const calls = [];
  return {
    calls,
    available: () => available,
    askMessage: async (params) => { calls.push(params); return typeof reply === "function" ? reply(params) : reply; },
  };
}

const hit = (fileId, name, page, text = `page ${page} of ${name}`) => ({ fileId, name, folder: "Catalogues", page, snippet: "…", size: 1, text });
const searchOf = (hits) => { const calls = []; const fn = (q, o) => { calls.push([q, o]); return hits; }; fn.calls = calls; return fn; };

test("the answer lists the cited documents and pages", async () => {
  const ai = fakeAi(message([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Made in the USA.", citations: [cite(0)] },
    { type: "text", text: " Assembled in Qatar.", citations: [cite(1), cite(0)] },
    { type: "text", text: " Thanks." },
  ]));
  const r = await answerFromLibrary("trane country of origin", {
    ai, knowledge: ["Open 8 to 5"],
    search: searchOf([hit("f1", "APMR-A.pdf", 14), hit("f2", "Trane IOM.pdf", 3)]),
  });
  assert.equal(r.text, "Made in the USA. Assembled in Qatar. Thanks.");
  assert.deepEqual(r.sources[0], { fileId: "f1", name: "APMR-A", page: 14 });
  // first-cited order, and page 14 is not listed twice
  assert.deepEqual(r.sources, [
    { fileId: "f1", name: "APMR-A", page: 14 },
    { fileId: "f2", name: "Trane IOM", page: 3 },
  ]);
});

test("a page that was not cited is not listed, and a citation outside the pages is ignored", async () => {
  const ai = fakeAi(message([{ type: "text", text: "Yes.", citations: [cite(1), cite(7), cite(-1), { type: "char_location" }] }]));
  const r = await answerFromLibrary("q", { ai, knowledge: [], search: searchOf([hit("a", "A.pdf", 1), hit("b", "B.pdf", 2), hit("c", "C.pdf", 3)]) });
  assert.deepEqual(r.sources, [{ fileId: "b", name: "B", page: 2 }]);
});

test("the request: top pages as cited text documents, capped, with the knowledge and no forbidden fields", async () => {
  const ai = fakeAi(message([{ type: "text", text: "Yes.", citations: [cite(0)] }]));
  const huge = "x".repeat(MAX_PAGE_CHARS * 3);
  const hits = Array.from({ length: 7 }, (_, i) => hit(`f${i}`, `File ${i}.pdf`, i + 1, huge));
  await answerFromLibrary("how loud?", { ai, knowledge: ["Topic | Info line"], search: searchOf(hits) });
  assert.equal(ai.calls.length, 1);
  const p = ai.calls[0];
  assert.equal(p.purpose, "answerFromLibrary");
  assert.ok(p.max_tokens >= 1024);
  for (const k of ["temperature", "top_p", "top_k"]) assert.ok(!(k in p), k);
  assert.ok(!(p.output_config && "format" in p.output_config), "citations cannot be combined with output_config.format");
  const system = p.system.map((b) => b.text).join("\n");
  assert.ok(system.includes(PRODUCT_KB.slice(0, 200)), "PRODUCT_KB is in the system prompt");
  assert.ok(system.includes("Topic | Info line"), "Knowledge is in the system prompt");
  assert.match(system, /NO_ANSWER/);
  const content = p.messages[0].content;
  const docs = content.filter((b) => b.type === "document");
  assert.equal(docs.length, MAX_PAGES);
  assert.equal(MAX_PAGES, 5);
  assert.deepEqual(docs[0].citations, { enabled: true });
  assert.equal(docs[0].title, "File 0 p.1");
  assert.equal(docs[0].source.type, "text");
  assert.equal(docs[0].source.media_type, "text/plain");
  assert.equal(docs[0].source.data.length, MAX_PAGE_CHARS);
  assert.equal(content[content.length - 1].type, "text");
  assert.match(content[content.length - 1].text, /how loud\?/);
  assert.ok(content.slice(0, -1).every((b) => b.type === "document"), "documents first, the question last");
});

test("the search asks for page text, the top pages, and the same words as the question", async () => {
  const ai = fakeAi(message([{ type: "text", text: "NO_ANSWER" }]));
  const search = searchOf([]);
  await answerFromLibrary("q", { ai, knowledge: [], search, anyWord: false });
  assert.equal(search.calls[0][0], "q");
  assert.equal(search.calls[0][1].limit, MAX_PAGES);
  assert.equal(search.calls[0][1].textChars, MAX_PAGE_CHARS);
  assert.equal(search.calls[0][1].anyWord, false);
});

test("NO_ANSWER gives null so the caller falls through to the document search", async () => {
  for (const text of ["NO_ANSWER", "  NO_ANSWER.\n", "no_answer"]) {
    const ai = fakeAi(message([{ type: "text", text }]));
    assert.equal(await answerFromLibrary("q", { ai, knowledge: [], search: searchOf([hit("a", "A.pdf", 1)]) }), null, text);
  }
});

test("AI unavailable, a null reply, or an empty reply gives null without inventing anything", async () => {
  const off = fakeAi(message([{ type: "text", text: "hi", citations: [cite(0)] }]), { available: false });
  assert.equal(await answerFromLibrary("q", { ai: off, knowledge: [], search: searchOf([hit("a", "A.pdf", 1)]) }), null);
  assert.equal(off.calls.length, 0, "no call when AI is unavailable");
  const nul = fakeAi(null);
  assert.equal(await answerFromLibrary("q", { ai: nul, knowledge: [], search: searchOf([hit("a", "A.pdf", 1)]) }), null);
  const empty = fakeAi(message([{ type: "thinking", thinking: "" }]));
  assert.equal(await answerFromLibrary("q", { ai: empty, knowledge: [], search: searchOf([hit("a", "A.pdf", 1)]) }), null);
});

test("an answer with no citation, while pages were sent, is not trusted", async () => {
  const ai = fakeAi(message([{ type: "text", text: "It is 24.9 TR." }]));
  assert.equal(await answerFromLibrary("q", { ai, knowledge: [], search: searchOf([hit("a", "A.pdf", 1)]) }), null);
});

test("an uncited answer marked as coming from the product data or Knowledge is kept, with no sources", async () => {
  const ai = fakeAi(message([{ type: "text", text: "FROM_KB: Open 8 to 5." }]));
  const r = await answerFromLibrary("when are you open", { ai, knowledge: ["Hours | 8 to 5"], search: searchOf([hit("a", "A.pdf", 1)]) });
  assert.deepEqual(r, { text: "Open 8 to 5.", sources: [] });
});

test("a question with no matching pages uses only PRODUCT_KB and Knowledge", async () => {
  const ai = fakeAi(message([{ type: "text", text: "Open 8 to 5." }]));
  const r = await answerFromLibrary("when are you open", { ai, knowledge: ["Hours | 8 to 5"], search: searchOf([]) });
  assert.deepEqual(r, { text: "Open 8 to 5.", sources: [] });
  const content = ai.calls[0].messages[0].content;
  assert.ok(typeof content === "string" || content.every((b) => b.type !== "document"), "no document blocks");
  const system = ai.calls[0].system.map((b) => b.text).join("\n");
  assert.ok(system.includes("Hours | 8 to 5") && system.includes(PRODUCT_KB.slice(0, 200)));
});

test("a search that throws, and pages with no text, count as no pages", async () => {
  const boom = () => { throw new Error("db"); };
  const ai = fakeAi(message([{ type: "text", text: "Open 8 to 5." }]));
  const r = await answerFromLibrary("q", { ai, knowledge: [], search: boom });
  assert.deepEqual(r.sources, []);
  const ai2 = fakeAi(message([{ type: "text", text: "Open." }]));
  await answerFromLibrary("q", { ai: ai2, knowledge: [], search: searchOf([hit("a", "A.pdf", 1, ""), hit("b", "B.pdf", 2, "   ")]) });
  const content = ai2.calls[0].messages[0].content;
  assert.ok(typeof content === "string" || content.every((b) => b.type !== "document"));
});

test("one question makes one call", async () => {
  const ai = fakeAi(message([{ type: "text", text: "NO_ANSWER" }]));
  await answerFromLibrary("q", { ai, knowledge: [], search: searchOf([hit("a", "A.pdf", 1)]) });
  assert.equal(ai.calls.length, 1);
});

test("formatAnswer lists the sources under the answer", () => {
  assert.equal(formatAnswer({ text: "Yes.", sources: [] }), "Yes.");
  assert.equal(
    formatAnswer({ text: "Yes.", sources: [{ fileId: "a", name: "APMR-A", page: 14 }, { fileId: "b", name: "Trane IOM", page: 3 }] }),
    "Yes.\n\n📄 From:\n• APMR-A, page 14\n• Trane IOM, page 3");
});

test("formatPageHits numbers the pages with a short snippet and says nothing about credits or plans", () => {
  const text = formatPageHits('Pages that mention "scroll":', [
    { fileId: "a", name: "APMR-A.pdf", folder: "Catalogues", page: 14, snippet: "the  scroll\n compressor " + "y".repeat(300), size: 1 },
    { fileId: "b", name: "Other.pdf", folder: "IOM", page: 2, snippet: "", size: 1 },
  ]);
  assert.match(text, /^Pages that mention "scroll":\n\n1\. APMR-A, page 14\n/);
  assert.match(text, /2\. Other, page 2/);
  assert.ok(!/\n\s*\n\s*\n/.test(text));
  assert.ok(text.split("\n").every((l) => l.length < 200));
  assert.doesNotMatch(text, /credit|plan|paused/i);
});

test("libraryQuery takes find/search commands and nothing else", () => {
  assert.equal(libraryQuery("find sound level"), "sound level");
  assert.equal(libraryQuery("  Search  Trane country of origin "), "Trane country of origin");
  assert.equal(libraryQuery("FIND apmr"), "apmr");
  for (const t of ["find", "search", "search ", "finder", "searching for x", "research apmr", "search all", "search all files", "search everything", "ai search", "search with ai", "hello find me"]) {
    assert.equal(libraryQuery(t), null, t);
  }
});
