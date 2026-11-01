// ============================================================
//  Pure helpers for the chat screen. Works in Node (the tests) and in the
//  browser (window.Render); nothing here touches the page.
// ============================================================
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Render = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SHARE_FILE_MAX = 25 * 1024 * 1024; // above this the phone shares a link, not the file
  const MB = 1024 * 1024;

  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

  // Server text to safe HTML. Everything is escaped first; only then do we add
  // our own tags, so nothing typed or stored can open one. Links are https only.
  // Markers (private-use characters) hold the finished links out of the way of
  // *bold* and _italic_, which therefore never reach inside a URL.
  function renderRich(text) {
    let s = text === null || text === undefined ? "" : String(text);
    s = escapeHtml(s.replace(/[\uE000\uE001]/g, ""));
    const links = [];
    s = s.replace(/https:\/\/(?:[^\s&]|&amp;)+/g, (match) => {
      let url = match;
      let tail = "";
      for (;;) {
        const last = url.slice(-1);
        const unbalanced = last === ")" && url.split(")").length > url.split("(").length;
        if (/[.,;:!?]/.test(last) || unbalanced) { tail = last + tail; url = url.slice(0, -1); } else break;
      }
      if (url === "https://") return match;
      links.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
      return `\uE000${links.length - 1}\uE001${tail}`;
    });
    s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1<strong>$2</strong>");
    s = s.replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1<em>$2</em>");
    return s.replace(/\uE000(\d+)\uE001/g, (m, i) => links[Number(i)] || "");
  }

  // The size a photo is redrawn at: the long side is at most `max`.
  function imageTargetSize(w, h, max = 2000) {
    if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
    const long = Math.max(w, h);
    if (long <= max) return { w, h };
    const scale = max / long;
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
  }

  // "file": share the PDF itself. "link": share a link. An unknown size never
  // counts as small, because the file would be fetched before anyone knows how big it is.
  function shareMode(size, canShareFiles) {
    if (!canShareFiles) return "link";
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return "link";
    return size <= SHARE_FILE_MAX ? "file" : "link";
  }

  // Drive and generated files both come through /app/files, colon encoded.
  function fileRefUrl(ref, inline) {
    return "/app/files/" + encodeURIComponent(String(ref)) + (inline ? "?inline=1" : "");
  }

  function formatSize(bytes) {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
    return `${(Math.round((bytes / MB) * 10) / 10).toString()} MB`;
  }

  function fileKind(name) {
    const ext = (String(name || "").split(".").pop() || "").toLowerCase();
    if (ext === "pdf") return "pdf";
    if (["jpg", "jpeg", "png", "webp"].includes(ext)) return "image";
    if (["xlsx", "xls", "csv"].includes(ext)) return "sheet";
    return "other";
  }

  // Newest copy of each seq wins; the result is oldest first.
  function mergeMessages(have, incoming) {
    const bySeq = new Map();
    for (const m of have || []) bySeq.set(m.seq, m);
    for (const m of incoming || []) bySeq.set(m.seq, m);
    return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
  }

  return { renderRich, imageTargetSize, shareMode, fileRefUrl, formatSize, fileKind, mergeMessages, escapeHtml, SHARE_FILE_MAX };
}));
