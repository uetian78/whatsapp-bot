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
    if (["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(ext)) return "image";
    if (["xlsx", "xls", "csv"].includes(ext)) return "sheet";
    return "other";
  }

  // What a failed navigator.share() should lead to. `deniedBefore` is true when
  // this card already got a NotAllowedError on a tap with its file ready.
  //   "again"   the phone didn't count the tap: ask for one more
  //   "aborted" the person closed the share sheet: offer the link, change nothing
  //   "link"    anything else, or a second NotAllowedError (an in-app browser
  //             that never allows file sharing): share the link instead
  function shareOutcome(errorName, deniedBefore) {
    if (errorName === "NotAllowedError") return deniedBefore ? "link" : "again";
    if (errorName === "AbortError") return "aborted";
    return "link";
  }

  // Which file cards fetch their file before anyone taps, to spare mobile data.
  // While the chat is still opening (liveAfterSeq is null) only the newest card
  // that can be shared as a file; afterwards that card stays, and so does every
  // card that arrived after the chat opened. At most `max` are held, newest kept.
  // Any other card fetches on its first tap.
  function prefetchWanted(cards, openRef, liveAfterSeq, max = 3) {
    const eligible = (cards || []).filter((fc) => shareMode(fc.size, true) === "file");
    if (liveAfterSeq === null || liveAfterSeq === undefined) return eligible.slice(-1);
    return eligible.filter((fc) => fc.ref === openRef || fc.seq > liveAfterSeq).slice(-max);
  }

  // The server refuses a tap title over 200 characters; a long file name can be.
  function clipTitle(title, max = 150) {
    const t = String(title === null || title === undefined ? "" : title);
    return t.length <= max ? t : t.slice(0, max - 1) + "…";
  }

  // Message kinds whose features no longer exist. Old messages of these kinds are
  // still in people's chats; the screen shows OLD_RESULT_NOTE in their place.
  const RETIRED_KINDS = ["rowcheck"];
  const isRetiredKind = (kind) => RETIRED_KINDS.includes(kind);
  const OLD_RESULT_NOTE = "This older result is no longer available.";

  return { isRetiredKind, OLD_RESULT_NOTE, renderRich, imageTargetSize, shareMode, fileRefUrl, formatSize, fileKind, shareOutcome, prefetchWanted, clipTitle, escapeHtml, SHARE_FILE_MAX };
}));
