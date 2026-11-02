const test = require("node:test");
const assert = require("node:assert");
const {
  renderRich, shareMode, fileRefUrl, formatSize, fileKind, shareOutcome, prefetchWanted, clipTitle, isRetiredKind, isGeneratedRef, OLD_RESULT_NOTE, SHARE_FILE_MAX,
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
  assert.equal(fileKind("IMG_0001.HEIC"), "image", "a typeless iPhone photo is still a photo");
  assert.equal(fileKind("IMG_0002.heif"), "image");
  assert.equal(fileKind("book.xlsx"), "sheet");
  assert.equal(fileKind("book.csv"), "sheet");
  assert.equal(fileKind("notes.docx"), "other");
  assert.equal(fileKind(undefined), "other");
});

test("a failed share leads to: one more tap, then the link; closing the sheet offers the link", () => {
  assert.equal(shareOutcome("NotAllowedError", false), "again");
  assert.equal(shareOutcome("NotAllowedError", true), "link", "a second refusal (an in-app browser) goes to the link");
  assert.equal(shareOutcome("AbortError", false), "aborted");
  assert.equal(shareOutcome("AbortError", true), "aborted");
  assert.equal(shareOutcome("TypeError", false), "link");
  assert.equal(shareOutcome(undefined, false), "link");
});

test("only the newest file card is fetched ahead on open, then cards that arrive live", () => {
  const card = (seq, size = 1000) => ({ seq, ref: `drive:f${seq}`, size });
  const cards = [card(1), card(2), card(3), card(4), card(5)];
  // opening: just the newest
  assert.deepEqual(prefetchWanted(cards, null, null).map((c) => c.seq), [5]);
  // opened with 5 as newest; nothing new yet
  assert.deepEqual(prefetchWanted(cards, "drive:f5", 5).map((c) => c.seq), [5]);
  // two arrive live: they join the one from open
  const live = [...cards, card(6), card(7)];
  assert.deepEqual(prefetchWanted(live, "drive:f5", 5).map((c) => c.seq), [5, 6, 7]);
  // at most `max` are held, newest kept
  const many = [...live, card(8), card(9)];
  assert.deepEqual(prefetchWanted(many, "drive:f5", 5, 3).map((c) => c.seq), [7, 8, 9]);
  // cards too big or of unknown size are never fetched ahead
  const mixed = [card(1), card(2, 30 * 1024 * 1024), card(3, null)];
  assert.deepEqual(prefetchWanted(mixed, null, null).map((c) => c.seq), [1]);
  assert.deepEqual(prefetchWanted([], null, null), []);
});

test("a tap title is clipped to 150 characters, short ones untouched", () => {
  assert.equal(clipTitle("Page 3 as PDF"), "Page 3 as PDF");
  const long = "Submittal Paperwork ".repeat(20);
  const clipped = clipTitle(long);
  assert.equal(clipped.length, 150);
  assert.ok(long.startsWith(clipped.slice(0, -1)));
  assert.equal(clipTitle("x".repeat(150)).length, 150);
  assert.equal(clipTitle(undefined), "");
});


test("results of features that are gone show as one short note; live kinds are left alone", () => {
  assert.equal(OLD_RESULT_NOTE, "This older result is no longer available.");
  assert.equal(isRetiredKind("rowcheck"), true);
  for (const kind of ["text", "choices", "file", "note", "something-new"]) assert.equal(isRetiredKind(kind), false, kind);
});

test("a card for a generated file from an older version is recognised, a Drive card is not", () => {
  assert.equal(isGeneratedRef("gen:0b1c2d3e-0000-4000-8000-000000000000"), true);
  for (const ref of ["drive:abc", "", null, undefined, 5]) assert.equal(isGeneratedRef(ref), false, String(ref));
});
