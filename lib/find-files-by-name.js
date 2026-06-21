// lib/find-files-by-name.js
// Matches user-typed text against Drive filenames. Three tiers, in order of
// confidence: exact name, one string fully containing the other (handles a
// code or partial name), then a word-overlap fallback for queries that have
// every word of the filename but with something else inserted between them
// (e.g. "SKM company profile" vs "SKM Profile.pdf" — "company" breaks the
// contiguous-substring checks above it but every word of the filename is
// still present in the query).
'use strict';

function norm(s) {
  return s.toLowerCase().replace(/[\s\-_.]/g, "");
}

function tokenize(s) {
  return s.toLowerCase().split(/[\s\-_.]+/).filter(Boolean);
}

function findFilesByName(text, files) {
  const q = norm(text.trim());
  if (!q) return [];
  const qTokens = new Set(tokenize(text.trim()));

  const scored = [];
  for (const f of files) {
    const baseRaw = f.name.replace(/\.[^.]+$/, "");
    const base = norm(baseRaw);
    if (base === q) { scored.push({ f, rank: 0 }); continue; }       // exact
    if (base.includes(q)) { scored.push({ f, rank: 1 }); continue; } // query inside name
    if (q.includes(base)) { scored.push({ f, rank: 2 }); continue; } // name inside query

    const fTokens = tokenize(baseRaw);
    if (fTokens.length && fTokens.every((t) => qTokens.has(t))) {
      scored.push({ f, rank: 3 }); // every word of the filename is in the query
    }
  }
  if (!scored.length) return [];

  // If any exact/closer matches exist, return only the best tier.
  const best = Math.min(...scored.map((s) => s.rank));
  return scored.filter((s) => s.rank === best).map((s) => s.f);
}

module.exports = { findFilesByName };
