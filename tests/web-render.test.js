const test = require("node:test");
const assert = require("node:assert");
const {
  renderRich, imageTargetSize, shareMode, fileRefUrl, formatSize, fileKind, mergeMessages, SHARE_FILE_MAX,
} = require("../web/public/render.js");

test("HTML is escaped", () => {
  assert.doesNotMatch(renderRich("<img src=x onerror=1>"), /<img/);
  assert.match(renderRich("<img src=x onerror=1>"), /&lt;img/);
  assert.doesNotMatch(renderRich('"><script>alert(1)</script>'), /<script/);
  assert.equal(renderRich("a & b"), "a &amp; b");
});

test("*bold* and _italic_ render; a lone star stays a star", () => {
  assert.match(renderRich("*Hi*"), /<strong>Hi<\/strong>/);
  assert.match(renderRich("say _hello_ now"), /<em>hello<\/em>/);
  assert.equal(renderRich("5 * 2"), "5 * 2");
  assert.equal(renderRich("5 * 2 * 3"), "5 * 2 * 3");
  assert.equal(renderRich("snake_case_name"), "snake_case_name");
  assert.match(renderRich("*Closest matches:*\n1. Chiller"), /<strong>Closest matches:<\/strong>\n1\. Chiller/);
});

test("bold and italic cannot open a tag from user text", () => {
  const out = renderRich('*<b onclick="x">hi</b>*');
  assert.doesNotMatch(out, /<b /);
  assert.match(out, /<strong>&lt;b onclick=&quot;x&quot;&gt;hi&lt;\/b&gt;<\/strong>/);
});

test("https links are clickable, javascript: is not", () => {
  const out = renderRich("See https://example.com/a?b=1&c=2 now");
  assert.match(out, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">https:\/\/example\.com\/a\?b=1&amp;c=2<\/a> now/);
  assert.doesNotMatch(renderRich("javascript:alert(1)"), /<a /);
  assert.doesNotMatch(renderRich("[x](javascript:alert(1)) http://plain.example"), /<a /);
  assert.doesNotMatch(renderRich("data:text/html,<b>x</b>"), /<a |<b>/);
});

test("a link keeps its punctuation outside, and underscores or stars inside it are left alone", () => {
  assert.match(renderRich("Open (https://example.com/x)."), /<a [^>]*>https:\/\/example\.com\/x<\/a>\)\./);
  const out = renderRich("https://example.com/a_b_c and *x* https://example.com/*y*");
  assert.doesNotMatch(out, /<em>/);
  assert.match(out, /<strong>x<\/strong>/);
  assert.match(out, /href="https:\/\/example\.com\/\*y\*"/);
});

test("a quote in a link cannot break out of the attribute", () => {
  const out = renderRich('https://example.com/"onmouseover="alert(1)');
  assert.doesNotMatch(out, /<[^>]*onmouseover/);
  assert.match(out, /href="https:\/\/example\.com\/"/);
});

test("renderRich copes with non-strings and private-use characters", () => {
  assert.equal(renderRich(null), "");
  assert.equal(renderRich(undefined), "");
  assert.equal(renderRich(12), "12");
  assert.doesNotMatch(renderRich("\uE000 0 \uE001 https://a.example"), /undefined/);
});

test("photos shrink to 2000 px on the long side and small ones stay", () => {
  assert.deepEqual(imageTargetSize(4000, 3000), { w: 2000, h: 1500 });
  assert.deepEqual(imageTargetSize(3000, 4000), { w: 1500, h: 2000 });
  assert.deepEqual(imageTargetSize(800, 600), { w: 800, h: 600 });
  assert.deepEqual(imageTargetSize(2000, 2000), { w: 2000, h: 2000 });
  assert.deepEqual(imageTargetSize(5000, 100, 1000), { w: 1000, h: 20 });
  assert.deepEqual(imageTargetSize(20000, 3), { w: 2000, h: 1 });
});

test("files over 25 MB or without file sharing use a link", () => {
  assert.equal(shareMode(26 * 1024 * 1024, true), "link");
  assert.equal(shareMode(1000, false), "link");
  assert.equal(shareMode(1000, true), "file");
  assert.equal(shareMode(SHARE_FILE_MAX, true), "file");
  assert.equal(shareMode(SHARE_FILE_MAX + 1, true), "link");
  assert.equal(SHARE_FILE_MAX, 25 * 1024 * 1024);
});

test("an unknown size never prefetches: it uses the link", () => {
  for (const size of [null, undefined, NaN, "abc", -1, 0, Infinity]) {
    assert.equal(shareMode(size, true), "link", String(size));
  }
});

test("file refs go through /app/files with the colon encoded", () => {
  assert.equal(fileRefUrl("drive:abc_DEF-1"), "/app/files/drive%3Aabc_DEF-1");
  assert.equal(fileRefUrl("gen:0b1c2d3e-0000-4000-8000-000000000000", true), "/app/files/gen%3A0b1c2d3e-0000-4000-8000-000000000000?inline=1");
  assert.equal(fileRefUrl("drive:a/b?c"), "/app/files/drive%3Aa%2Fb%3Fc");
});

test("sizes are shown in plain words", () => {
  assert.equal(formatSize(null), "");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(2048), "2 KB");
  assert.equal(formatSize(1.5 * 1024 * 1024), "1.5 MB");
  assert.equal(formatSize(30 * 1024 * 1024), "30 MB");
});

test("files are told apart by their name", () => {
  assert.equal(fileKind("Sheet.PDF"), "pdf");
  assert.equal(fileKind("photo.jpeg"), "image");
  assert.equal(fileKind("a.png"), "image");
  assert.equal(fileKind("a.webp"), "image");
  assert.equal(fileKind("book.xlsx"), "sheet");
  assert.equal(fileKind("book.csv"), "sheet");
  assert.equal(fileKind("notes.docx"), "other");
  assert.equal(fileKind(undefined), "other");
});

test("messages are merged by seq, so an optimistic bubble and the server's copy do not double", () => {
  const have = [{ seq: 1, role: "user", body: "hi" }, { seq: 2, role: "bot", body: "hello" }];
  const merged = mergeMessages(have, [{ seq: 2, role: "bot", body: "hello" }, { seq: 3, role: "bot", body: "more" }]);
  assert.deepEqual(merged.map((m) => m.seq), [1, 2, 3]);
  const sorted = mergeMessages([], [{ seq: 5 }, { seq: 3 }, { seq: 5 }]);
  assert.deepEqual(sorted.map((m) => m.seq), [3, 5]);
  assert.deepEqual(mergeMessages(have, []).map((m) => m.seq), [1, 2]);
});
