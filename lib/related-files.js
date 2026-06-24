// lib/related-files.js
// Parses an AI "related documents" reply (e.g. "0", "3", "1, 4, 7") into
// actual file objects: extracts every number, drops out-of-range/duplicate
// numbers, keeps best-first order, caps at maxResults. A bare "0" (the
// model's "nothing relevant" signal) naturally yields [] since 0 fails the
// `n >= 1` range check below — no special-casing needed.
'use strict';

function parseRelatedFilesResponse(rawText, files, maxResults = 5) {
  const nums = (rawText || "").match(/\d+/g);
  if (!nums) return [];

  const seen = new Set();
  const picked = [];
  for (const numStr of nums) {
    const n = parseInt(numStr, 10);
    if (n < 1 || n > files.length) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    picked.push(files[n - 1]);
    if (picked.length >= maxResults) break;
  }
  return picked;
}

module.exports = { parseRelatedFilesResponse };
