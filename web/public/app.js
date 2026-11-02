// ============================================================
//  HVAC Assistant chat screen.
//
//  Everything that comes from the server, a document, a Sheet or a person is
//  untrusted: bot text goes through Render.renderRich (which escapes first) and
//  every other string is set with textContent. The page's policy forbids inline
//  script and style, so all styling is in styles.css.
// ============================================================
(function () {
  "use strict";

  const R = window.Render;
  const $ = (id) => document.getElementById(id);

  const POLL_BUSY_MS = 1500;     // while the bot is working
  const POLL_OFFLINE_MS = 3000;  // after a failed request, until one works
  const PREFETCH_MAX = 3;        // PDFs held in memory ready to share, at most (see Render.prefetchWanted)
  const PAGE_SIZE = 200;

  const COPY = {
    emptySend: "Type a message first",
    offline: "You're offline. Trying again…",
    starting: "Service is starting. Trying again…",
    sendLink: "Send a link instead",
    typing: "Typing…",
    signIn: "Ask for your personal link to sign in.",
    generic: "Something went wrong. Try again.",
    reload: "Please reload the page and try again.",
    notSent: "Not sent. What you typed is still in the box.",
    notSentShort: "Couldn't send that. Check your connection and try again.",
    tapAgain: "Tap again to share",
    shareFailed: "Couldn't open the share sheet. Try again.",
    shareLinkFailed: "Couldn't make a share link. Try again.",
  };

  const MIME_BY_EXT = {
    pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel", csv: "text/csv",
  };
  const mimeForName = (name) => MIME_BY_EXT[(String(name || "").split(".").pop() || "").toLowerCase()] || "application/octet-stream";

  const ICON_SHARE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>';

  const els = {
    messages: $("messages"), text: $("text"), form: $("composer"), send: $("send"),
    saved: $("saved"), banner: $("banner"), toast: $("toast"), jump: $("jump"),
    gate: $("gate"), gateMsg: $("gate-msg"),
  };

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // ---------------------------------------------------------------
  //  State
  // ---------------------------------------------------------------
  const seen = new Map();   // seq -> element (null for kinds we do not draw)
  const rendered = [];      // { msg, el, chips?, buttons? } in the order shown
  const pendings = [];      // bubbles for messages still on their way to the server
  const fileCards = [];     // { seq, ref, name, size, btn } newest last
  let lastSeq = 0;
  let lastDay = "";
  let busy = false;
  let offline = false;
  let signedOut = false;
  let loaded = false;
  let openRef = null;       // the file card that was newest when the chat opened: it is fetched ahead
  let liveAfter = null;     // its seq: cards after this arrived live and are fetched ahead too
  let stick = true;         // the person is at the bottom, so new messages scroll into view
  let pollTimer = null;
  let inFlight = false;
  let queued = false;

  const typingEl = (() => {
    const e = h("div", "typing");
    e.setAttribute("role", "status");
    e.append(h("i"), h("i"), h("i"), h("span", "", COPY.typing));
    return e;
  })();

  // ---------------------------------------------------------------
  //  Small UI helpers
  // ---------------------------------------------------------------
  let toastTimer = null;
  function toast(text) {
    els.toast.textContent = text;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4500);
  }

  // `copy` is what the banner says (default: offline). A 503 means the service is
  // waking up, which is not the person's connection.
  function setOffline(value, copy) {
    const text = value ? (copy || COPY.offline) : "";
    const changed = offline !== value;
    if (!changed && els.banner.textContent === text) return;
    offline = value;
    els.banner.textContent = text;
    els.banner.hidden = !value;
    if (changed) schedule();
  }

  function signOut() {
    if (signedOut) return;
    signedOut = true;
    clearTimeout(pollTimer);
    els.gateMsg.textContent = COPY.signIn;
    els.gate.hidden = false;
  }

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
    stick = true;
    els.jump.hidden = true;
  }
  els.messages.addEventListener("scroll", () => {
    const m = els.messages;
    stick = m.scrollHeight - m.scrollTop - m.clientHeight < 90;
    if (stick) els.jump.hidden = true;
  });
  els.jump.addEventListener("click", scrollToBottom);

  function timeLabel(ts) {
    if (!ts) return "";
    try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; }
  }
  function dayLabel(ts) {
    const d = new Date(ts);
    const key = d.toDateString();
    const today = new Date();
    if (key === today.toDateString()) return { key, label: "Today" };
    const yest = new Date(today.getTime() - 86400000);
    if (key === yest.toDateString()) return { key, label: "Yesterday" };
    return { key, label: d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) };
  }

  // ---------------------------------------------------------------
  //  Building messages
  // ---------------------------------------------------------------
  function withTime(el, ts) {
    const t = timeLabel(ts);
    if (t) el.append(h("time", "time", t));
    return el;
  }

  function textMsg(m) {
    const user = m.role === "user";
    const el = h("div", `msg ${user ? "user" : "bot"}`);
    const body = h("div", "text");
    if (user) body.textContent = String(m.body == null ? "" : m.body);
    else body.innerHTML = R.renderRich(m.body);
    el.append(body);
    return withTime(el, m.ts);
  }

  function noteMsg(m) {
    return h("div", "msg note-msg", String(m.body));
  }

  function choicesMsg(m, entry) {
    const b = m.body && typeof m.body === "object" ? m.body : {};
    const choices = Array.isArray(b.choices) ? b.choices.filter((c) => c && typeof c.id === "string" && typeof c.title === "string") : [];
    const el = h("div", "msg bot");
    if (b.text) {
      const t = h("div", "text");
      t.innerHTML = R.renderRich(b.text);
      el.append(t);
    }
    if (choices.length) {
      const rows = choices.some((c) => c.description);
      const box = h("div", rows ? "chips rows" : "chips");
      entry.chips = box;
      for (const c of choices) {
        const chip = h("button", "chip");
        chip.type = "button";
        chip.dataset.title = c.title;
        chip.append(document.createTextNode(c.title));
        if (c.description) chip.append(h("span", "desc", c.description));
        chip.addEventListener("click", () => { sendTap(c.id, c.title, chip); });
        box.append(chip);
      }
      el.append(box);
    }
    return withTime(el, m.ts);
  }

  const KIND_LABEL = { pdf: "PDF", image: "IMG", sheet: "XLS", other: "FILE" };

  function openLink(href, label) {
    const a = h("a", "btn", label);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  function fileMsg(m, entry) {
    const b = m.body && typeof m.body === "object" ? m.body : null;
    if (!b || typeof b.ref !== "string" || !/^(drive|gen):/.test(b.ref)) return null;
    const name = typeof b.name === "string" && b.name ? b.name : "File";
    const kind = R.fileKind(name);
    const size = typeof b.size === "number" ? b.size : null;
    const meta = [typeof b.folder === "string" ? b.folder : "", R.formatSize(size).replace(" ", " ")].filter(Boolean).join(" · ");

    const el = h("div", "msg bot wide");
    const card = h("div", "card");
    if (kind === "image") {
      const a = h("a", "card-image");
      a.href = R.fileRefUrl(b.ref, true);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      const img = document.createElement("img");
      img.alt = name;
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("load", () => { if (stick) scrollToBottom(); });
      img.addEventListener("error", () => a.classList.add("broken"));
      img.src = R.fileRefUrl(b.ref, true);
      a.append(img);
      card.append(a);
    }
    const head = h("div", "card-head");
    const title = h("div", "card-title");
    title.append(h("div", "card-name", name));
    if (meta) title.append(h("div", "card-meta", meta));
    head.append(h("span", "badge", KIND_LABEL[kind]), title);
    card.append(head);
    if (typeof b.caption === "string" && b.caption && b.caption !== name.replace(/\.[^.]+$/, "")) card.append(h("div", "card-caption", b.caption));

    const actions = h("div", "card-actions");
    actions.append(openLink(R.fileRefUrl(b.ref, kind === "pdf" || kind === "image"), "Open"));
    const btn = h("button", "btn primary");
    btn.type = "button";
    btn.innerHTML = ICON_SHARE;
    const label = h("span", "", "Share to WhatsApp");
    btn.append(label);
    // Shown only after the person closed the share sheet (say WhatsApp wasn't
    // listed): the way out that doesn't need the sheet.
    const linkBtn = h("button", "btn", COPY.sendLink);
    linkBtn.type = "button";
    linkBtn.hidden = true;
    const fc = { seq: m.seq, ref: b.ref, name, size, btn, label, linkBtn, busy: false, denied: false };
    btn.addEventListener("click", () => onShareClick(fc));
    linkBtn.addEventListener("click", () => { linkBtn.hidden = true; shareLink(fc); });
    actions.append(btn, linkBtn);
    card.append(actions);
    el.append(card);
    entry.fileCard = fc;
    return withTime(el, m.ts);
  }

  function buildMessage(m, entry) {
    // Results from features that are gone (old messages still in the chat) show as a muted note.
    if (R.isRetiredKind(m.kind)) return noteMsg({ body: R.OLD_RESULT_NOTE });
    switch (m.kind) {
      case "text": return textMsg(m);
      case "choices": return choicesMsg(m, entry);
      case "file": return fileMsg(m, entry);
      default: return typeof m.body === "string" ? noteMsg(m) : null;
    }
  }

  // ---------------------------------------------------------------
  //  Putting messages on the screen
  // ---------------------------------------------------------------
  function place(el, ts) {
    if (ts) {
      const d = dayLabel(ts);
      if (d.key !== lastDay) {
        lastDay = d.key;
        els.messages.insertBefore(h("div", "day", d.label), typingEl.parentNode ? typingEl : null);
      }
    }
    els.messages.insertBefore(el, typingEl.parentNode ? typingEl : null);
  }

  function adoptPending(m) {
    if (typeof m.body !== "string") return false;
    const i = pendings.findIndex((p) => p.body === m.body);
    if (i < 0) return false;
    const p = pendings.splice(i, 1)[0];
    p.adopted = true;
    p.entry.msg = m;
    p.el.classList.remove("sending");
    seen.set(m.seq, p.el);
    return true;
  }

  function addServerMessages(list) {
    let added = false;
    let userAdded = false;
    for (const m of list) {
      if (!m || typeof m.seq !== "number" || seen.has(m.seq)) continue;
      if (m.seq > lastSeq) lastSeq = m.seq;
      if (m.role === "user" && adoptPending(m)) continue;
      const entry = { msg: m };
      const el = buildMessage(m, entry);
      if (!el) { seen.set(m.seq, null); continue; }
      entry.el = el;
      seen.set(m.seq, el);
      rendered.push(entry);
      if (entry.fileCard) fileCards.push(entry.fileCard);
      place(el, m.ts);
      added = true;
      if (m.role === "user") userAdded = true;
    }
    if (added) {
      refreshChoices();
      refreshPrefetch();
      if (stick || userAdded || !loaded) scrollToBottom();
      else els.jump.hidden = false;
    }
  }

  // The newest choices stay lit; older ones dim. The chip that was picked is filled.
  function refreshChoices() {
    let last = null;
    const withChips = [];
    for (const e of rendered) {
      if (e.chips) { last = e; withChips.push(e); continue; }
      if (e.msg.role === "user" && last) {
        for (const chip of last.chips.children) chip.classList.toggle("picked", R.clipTitle(chip.dataset.title) === e.msg.body);
        last = null;
      }
    }
    withChips.forEach((e, i) => e.chips.classList.toggle("stale", i < withChips.length - 1));
  }

  function setBusy(value) {
    busy = value;
    if (value) {
      els.messages.append(typingEl);
      if (stick) scrollToBottom();
    } else if (typingEl.parentNode) typingEl.remove();
    schedule();
  }

  // ---------------------------------------------------------------
  //  Talking to the server
  // ---------------------------------------------------------------
  async function api(path, opts) {
    const res = await fetch(path, { credentials: "same-origin", cache: "no-store", ...opts });
    let data = null;
    try { data = await res.json(); } catch (_) { /* not JSON */ }
    if (res.status === 401) signOut();
    return { ok: res.ok, status: res.status, data };
  }

  // What to show for a failed request. The server's own copy is written to be
  // read, for the cases where it says something useful; anything else is generic.
  function failureCopy(r) {
    if (r.status === 401) return null;
    if ([400, 413, 415].includes(r.status) && r.data && typeof r.data.error === "string") return r.data.error;
    if (r.status === 403) return COPY.reload;
    return COPY.generic;
  }

  // One request that changes something. Never throws: { ok, offline, copy, data }.
  async function post(path, body, contentType) {
    let r;
    try {
      r = await api(path, { method: "POST", headers: { "Content-Type": contentType }, body });
    } catch (_) {
      setOffline(true);
      return { ok: false, offline: true, copy: null };
    }
    setOffline(false);
    if (!r.ok) return { ok: false, copy: failureCopy(r) };
    if (r.data && r.data.busy) setBusy(true);
    poll();
    return { ok: true, data: r.data };
  }
  const postJson = (body) => post("/app/api/messages", JSON.stringify(body), "application/json");

  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (signedOut || document.hidden) return;
    if (busy) pollTimer = setTimeout(poll, POLL_BUSY_MS);
    else if (offline) pollTimer = setTimeout(poll, POLL_OFFLINE_MS);
    // Idle and online: nothing is scheduled, so the app can sleep until the next tap or focus.
  }

  async function poll() {
    if (signedOut) return;
    if (inFlight) { queued = true; return; }
    inFlight = true;
    clearTimeout(pollTimer);
    try {
      for (;;) {
        const after = lastSeq;
        const r = await api(after ? `/app/api/messages?after=${after}` : "/app/api/messages");
        if (!r.ok || !r.data || !Array.isArray(r.data.messages)) {
          if (r.status !== 401) setOffline(true, r.status === 503 ? COPY.starting : undefined);
          return;
        }
        setOffline(false);
        addServerMessages(r.data.messages);
        if (!loaded) { loaded = true; liveAfter = lastSeq; scrollToBottom(); }
        if (after && r.data.messages.length >= PAGE_SIZE) continue;
        setBusy(Boolean(r.data.busy));
        return;
      }
    } catch (_) {
      setOffline(true);
    } finally {
      inFlight = false;
      if (queued) { queued = false; poll(); } else schedule();
    }
  }

  window.addEventListener("focus", poll);
  window.addEventListener("online", poll);
  window.addEventListener("pageshow", (e) => { if (e.persisted) poll(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

  // ---------------------------------------------------------------
  //  Sending
  // ---------------------------------------------------------------
  // A bubble shown at once; the server's copy later takes its place (by text,
  // or by seq when the reply to the POST comes first).
  function addPending(body) {
    const el = h("div", "msg user sending");
    el.append(h("div", "text", body));
    const entry = { msg: { role: "user", kind: "text", body }, el };
    const p = { body, el, entry, adopted: false };
    pendings.push(p);
    rendered.push(entry);
    place(el, Date.now());
    refreshChoices();
    scrollToBottom();
    return p;
  }

  function dropPending(p) {
    const i = pendings.indexOf(p);
    if (i >= 0) pendings.splice(i, 1);
    const j = rendered.indexOf(p.entry);
    if (j >= 0) rendered.splice(j, 1);
    p.el.remove();
    refreshChoices();
  }

  function settlePending(p, seq) {
    if (p.adopted) return;
    const i = pendings.indexOf(p);
    if (i >= 0) pendings.splice(i, 1);
    p.el.classList.remove("sending");
    if (typeof seq === "number" && seen.has(seq) && seen.get(seq) !== p.el) { dropPending(p); return; }
    if (typeof seq === "number") { seen.set(seq, p.el); p.entry.msg = { seq, role: "user", kind: "text", body: p.body }; }
  }

  function autosize() {
    const t = els.text;
    t.style.height = "auto";
    const border = t.offsetHeight - t.clientHeight; // scrollHeight leaves the border out
    t.style.height = `${Math.min(t.scrollHeight + border, 140)}px`;
  }

  async function sendText() {
    const text = els.text.value.trim();
    if (!text) { toast(COPY.emptySend); return; }
    const p = addPending(text);
    els.text.value = "";
    autosize();
    const r = await postJson({ text });
    if (r.ok) { settlePending(p, r.data && r.data.seq); return; }
    dropPending(p);
    if (!els.text.value) { els.text.value = text; autosize(); }
    toast(r.offline ? COPY.notSent : (r.copy || COPY.notSentShort));
  }

  async function sendTap(id, title, button) {
    if (signedOut) return;
    title = R.clipTitle(title); // the server refuses a title over 200 characters
    if (button) button.disabled = true;
    const p = addPending(title);
    const r = await postJson({ tapId: id, tapTitle: title });
    if (button) button.disabled = false;
    if (r.ok) { settlePending(p, r.data && r.data.seq); return; }
    dropPending(p);
    if (r.copy) toast(r.copy); else if (r.offline) toast(COPY.notSentShort);
  }

  els.form.addEventListener("submit", (e) => { e.preventDefault(); sendText(); });
  els.send.addEventListener("mousedown", (e) => e.preventDefault()); // keep the keyboard up
  els.text.addEventListener("input", autosize);
  els.text.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    if (window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches) { e.preventDefault(); sendText(); }
  });
  els.saved.addEventListener("click", () => sendTap("saved|open", "Saved work", els.saved));

  // ---------------------------------------------------------------
  //  Share to WhatsApp
  //
  //  A phone only opens the share sheet inside a tap, so the file has to be on
  //  the page before the tap. To spare mobile data, only the newest file card
  //  when the chat opens, and each card that arrives while it is open, fetch
  //  their file in advance (small enough: Render.shareMode says "file", 25 MB or
  //  less). Older cards fetch on the first tap, and if the phone no longer
  //  counts the tap by then, the button says "Tap again to share" and the
  //  second tap shares at once; a second refusal, or closing the share sheet,
  //  leads to the link (wa.me) instead. Bigger files, or any whose size is
  //  unknown, never download: they share a link. Memory holds at most
  //  PREFETCH_MAX files, plus one for a tapped older card.
  // ---------------------------------------------------------------
  const canShareFiles = (() => {
    try {
      return typeof navigator.share === "function" && typeof navigator.canShare === "function"
        && navigator.canShare({ files: [new File(["x"], "a.pdf", { type: "application/pdf" })] });
    } catch (_) { return false; }
  })();

  const cache = new Map(); // ref -> { state: loading|ready|failed|toobig, file, controller, promise, pinned }

  function dropEntry(ref) {
    const e = cache.get(ref);
    if (!e) return;
    cache.delete(ref);
    if (e.state === "loading") { e.state = "dropped"; try { e.controller.abort(); } catch (_) { /* gone already */ } }
    e.file = null;
  }

  function fetchEntry(fc, pinned) {
    const entry = { state: "loading", file: null, controller: new AbortController(), promise: null, pinned: Boolean(pinned) };
    cache.set(fc.ref, entry);
    entry.promise = (async () => {
      try {
        const res = await fetch(R.fileRefUrl(fc.ref), { credentials: "same-origin", signal: entry.controller.signal });
        if (res.status === 401) signOut();
        if (!res.ok) throw new Error("status");
        const blob = await res.blob();
        if (entry.state === "dropped") return;
        if (blob.size > R.SHARE_FILE_MAX) { entry.state = "toobig"; return; }
        const type = blob.type && blob.type !== "application/octet-stream" ? blob.type : mimeForName(fc.name);
        entry.file = new File([blob], fc.name, { type });
        entry.state = "ready";
      } catch (_) {
        if (entry.state !== "dropped") entry.state = "failed";
      }
    })();
    return entry;
  }

  function refreshPrefetch() {
    if (!canShareFiles) return;
    const wanted = R.prefetchWanted(fileCards, openRef, liveAfter, PREFETCH_MAX);
    if (liveAfter === null) openRef = wanted.length ? wanted[0].ref : null; // still opening: remember the newest
    const keep = new Set(wanted.map((fc) => fc.ref));
    for (const [ref, e] of Array.from(cache)) if (!keep.has(ref) && !e.pinned) dropEntry(ref);
    for (const fc of wanted) {
      const e = cache.get(fc.ref);
      if (!e) fetchEntry(fc, false);
    }
  }

  function setShareLabel(fc, text) { fc.label.textContent = text; }

  function unpin(fc) {
    const e = cache.get(fc.ref);
    if (e) e.pinned = false;
    refreshPrefetch();
  }

  async function shareLink(fc) {
    setShareLabel(fc, "Getting link…");
    let r;
    try { r = await api("/app/api/share-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: fc.ref }) }); }
    catch (_) { setOffline(true); toast(COPY.shareLinkFailed); return; }
    finally { setShareLabel(fc, "Share to WhatsApp"); }
    if (r.status === 401) return;
    if (!r.ok || !r.data || typeof r.data.url !== "string") {
      toast(r.data && typeof r.data.error === "string" && r.status === 404 ? r.data.error : COPY.shareLinkFailed);
      return;
    }
    // A plain navigation: a pop-up opened after a wait is blocked on phones.
    window.location.href = `https://wa.me/?text=${encodeURIComponent(r.data.url)}`;
  }

  // Called inside the tap, before any waiting, so the phone still counts it.
  function shareReadyFile(fc, entry) {
    let can = false;
    try { can = navigator.canShare({ files: [entry.file] }); } catch (_) { can = false; }
    if (!can) return shareLink(fc);
    return navigator.share({ files: [entry.file], title: fc.name }).then(
      () => { fc.denied = false; fc.linkBtn.hidden = true; setShareLabel(fc, "Share to WhatsApp"); unpin(fc); },
      (err) => {
        const outcome = R.shareOutcome(err && err.name, fc.denied);
        // The phone no longer counted the tap: keep the file for one more.
        if (outcome === "again") { fc.denied = true; setShareLabel(fc, COPY.tapAgain); return undefined; }
        // A second refusal on a fresh tap means this browser won't share files at all.
        fc.denied = false;
        unpin(fc);
        setShareLabel(fc, "Share to WhatsApp");
        if (outcome === "aborted") { fc.linkBtn.hidden = false; return undefined; }
        return shareLink(fc);
      });
  }

  async function onShareClick(fc) {
    if (fc.busy) return;
    fc.busy = true;
    try {
      if (R.shareMode(fc.size, canShareFiles) !== "file") { await shareLink(fc); return; }
      let entry = cache.get(fc.ref);
      if (entry && entry.state === "ready") { await shareReadyFile(fc, entry); return; } // no waiting before the share sheet
      if (!entry || entry.state === "failed") {
        for (const [ref, e] of Array.from(cache)) if (e.pinned) dropEntry(ref); // one tapped-card file at a time
        entry = fetchEntry(fc, true);
      }
      setShareLabel(fc, "Getting file…");
      await entry.promise;
      if (entry.state === "ready") {
        // The phone may no longer count this tap. If so the file stays here for the next one.
        await shareReadyFile(fc, entry);
        return;
      }
      setShareLabel(fc, "Share to WhatsApp");
      unpin(fc);
      if (entry.state === "toobig") { await shareLink(fc); return; }
      toast(COPY.shareFailed);
    } finally {
      fc.busy = false;
    }
  }

  // ---------------------------------------------------------------
  //  Go
  // ---------------------------------------------------------------
  autosize();
  poll();
})();
