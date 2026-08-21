// ============================================================
//  Broad, deterministic search across the WHOLE Drive index.
//
//  Two jobs, both pure JS — no Claude call, so this works on the
//  free plan and costs nothing:
//
//   1. hasSearchableExtras() — does a query carry real words
//      beyond the series name? "fcu" is a series menu request;
//      "fcu coil connection sheet" is a search. Without this the
//      router throws the extra words away and offers Catalogue/IOM.
//
//   2. rankFiles() — score every indexed file against the query,
//      matching the FOLDER PATH as well as the filename, so
//      "Submittal Files/07 - Coil Connection/" helps a vague
//      query find its file. Used for the "search all files"
//      escape hatch when a suggestion was wrong.
// ============================================================

// Words that carry no search signal: doc-type words the router already
// handles, plus ordinary filler. "sheet", "coil", "connection" etc. are
// deliberately NOT here — they are exactly the signal we want to keep.
const NOISE = new Set([
  "catalogue", "catalog", "catalogues", "catalogs", "iom", "ioms", "manual",
  "manuals", "pdf", "file", "files", "document", "documents", "doc", "docs",
  "please", "send", "me", "my", "the", "a", "an", "of", "for", "and", "to",
  "i", "want", "need", "get", "give", "got", "do", "you", "have", "has",
  "is", "it", "any", "some", "can", "could", "would", "with", "on", "in",
  "show", "share", "find", "search", "look", "looking", "kindly", "pls", "plz",
]);

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Query words worth searching on: filler and doc-type words removed, and
// pure noise like a lone "s" dropped.
function meaningfulTokens(text) {
  return tokenize(text).filter((t) => t.length > 1 && !NOISE.has(t));
}

// Does this query say more than just the series name? Decides whether the
// router offers the Catalogue/IOM menu or searches the whole index first.
// `series` may be null when the caller has no series in hand.
function hasSearchableExtras(text, series) {
  const seriesTokens = new Set(tokenize(series));
  return meaningfulTokens(text).some((t) => !seriesTokens.has(t));
}

// Score one file against the query tokens. A hit in the filename is worth
// more than a hit in the folder path, but folder hits matter — they're what
// lets "coil connection" find a file sitting in a "Coil Connection" folder.
function scoreFile(tokens, file) {
  const name = norm((file.name || "").replace(/\.[^.]+$/, ""));
  const folder = norm(file.folder || "");
  let score = 0;
  let matched = 0;

  for (const token of tokens) {
    const t = norm(token);
    if (!t) continue;
    if (name.includes(t)) { score += 3; matched++; }
    else if (folder.includes(t)) { score += 1; matched++; }
  }

  // Whole query appearing intact in the filename is the strongest signal.
  if (tokens.length > 1 && name.includes(norm(tokens.join("")))) score += 5;

  return { score, matched };
}

// Rank the whole index against a free-text query. Returns at most `limit`
// files, best first. Files matching too little of the query are dropped so a
// three-word query doesn't return every file sharing one common word.
function rankFiles(text, files, limit = 10) {
  const tokens = meaningfulTokens(text);
  if (!tokens.length) return [];

  // With 3+ words, demand at least half of them; with 1-2, one hit will do.
  const required = tokens.length >= 3 ? Math.ceil(tokens.length / 2) : 1;

  const scored = [];
  for (const file of files || []) {
    const { score, matched } = scoreFile(tokens, file);
    if (matched >= required && score > 0) scored.push({ file, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Same score: prefer the shorter name — it's the more specific document.
    return (a.file.name || "").length - (b.file.name || "").length;
  });

  return scored.slice(0, limit).map((s) => s.file);
}

// "search all", "search all files", "search everything", "search drive".
const SEARCH_ALL_HINT = "🔍 Not what you wanted? Reply *search all* to search every file in the Drive folder.";

function isSearchAllTrigger(text) {
  return /^\s*search\s+(all|everything|drive)(\s+files?)?\s*$/i.test(String(text ?? ""));
}

module.exports = {
  tokenize, meaningfulTokens, hasSearchableExtras,
  scoreFile, rankFiles, isSearchAllTrigger, SEARCH_ALL_HINT, NOISE,
};
