// ============================================================
//  Web adapter for the send facade (lib/channel.js): instead of calling
//  WhatsApp, every reply is saved as a message in lib/conversations.js and the
//  chat page picks it up with since(). `to` is the web user's id.
//
//  Message bodies by kind:
//    text      the string (longText is one message too; the page scrolls)
//    choices   { text, label?, choices: [{ id, title, description }] }
//              (buttons and lists look the same on the web)
//    file      { ref: "drive:<id>", name, folder, size }
//              { ref: "gen:<uuid>", name, mime, size, caption }
//    pages     { prompt, hits: [{ ref, fileId, name, folder, page, snippet,
//              size, pdfTap, imageTap }] } - the two taps are the ids the
//              "Page as PDF" / "Page as image" buttons send back
//
//  Generated files (submittal PDFs, VRF xlsx) are kept as bytes in
//  <dataDir>/generated/<uuid>, described by a generated_files row, and read
//  back with readGenerated(id, user). cleanupGenerated() is called once at
//  startup, never from a timer, so the app can sleep.
//
//  Every reply is also passed to crm.logOutbound in the payload shape
//  lib/wa.js sends, so the usage log keeps working. A CRM failure never
//  breaks the reply.
// ============================================================
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pageTapId } = require("./page-extract.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_MS = 30 * DAY_MS;
const DEFAULT_MAX_MB = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXT_MIME = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function mimeFromName(name) {
  const ext = (String(name || "").split(".").pop() || "").toLowerCase();
  return EXT_MIME[ext] || "application/octet-stream";
}

const isImage = (name) => /\.(png|jpe?g)$/i.test(name || "");

function maxGeneratedBytes() {
  const mb = Number(process.env.GENERATED_MAX_MB);
  return (Number.isFinite(mb) && mb >= 0 && process.env.GENERATED_MAX_MB !== "" ? mb : DEFAULT_MAX_MB) * 1024 * 1024;
}

function createWebChannel({ conversations, dataDir, now = Date.now, uploads, crm }) {
  // The generated_files table lives in the same database as the messages.
  const db = conversations.db;
  const generatedDir = () => path.join(typeof dataDir === "function" ? dataDir() : dataDir, "generated");

  const logCrm = (to, payload) => {
    try {
      (crm || require("../crm.js")).logOutbound(to, payload);
    } catch (e) {
      console.error("CRM logOutbound error (web):", e.message);
    }
  };
  const textPayload = (to, body) => ({ messaging_product: "whatsapp", to, type: "text", text: { preview_url: true, body } });
  const docPayload = (to, name, caption) =>
    isImage(name)
      ? { messaging_product: "whatsapp", to, type: "image", image: { caption: caption || "" } }
      : { messaging_product: "whatsapp", to, type: "document", document: { filename: name, caption: caption || "" } };

  const say = (to, kind, body) => conversations.append(to, "bot", kind, body);

  const normalizeChoices = (rows) =>
    (rows || []).map((r) => ({ id: String(r.id), title: r.title || "", description: r.description || "" }));

  return {
    name: "web",
    supports: { rowCheck: true },

    typing: async () => {},

    downloadMedia: async (id) => {
      const found = uploads && typeof uploads.get === "function" ? await uploads.get(id) : null;
      if (!found) throw new Error(`Upload not found: ${id}`);
      return found;
    },

    text: async (to, body) => {
      say(to, "text", body);
      logCrm(to, textPayload(to, body));
      return true;
    },

    longText: async (to, body) => {
      if (!body) return undefined;
      say(to, "text", body);
      logCrm(to, textPayload(to, body));
      return true;
    },

    buttons: async (to, text, buttons) => {
      const choices = normalizeChoices(buttons);
      say(to, "choices", { text, choices });
      logCrm(to, {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
          type: "button", body: { text },
          action: { buttons: choices.map((c) => ({ type: "reply", reply: { id: c.id, title: c.title } })) },
        },
      });
      return true;
    },

    list: async (to, text, label, rows) => {
      const choices = normalizeChoices(rows);
      say(to, "choices", { text, label, choices });
      logCrm(to, {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
          type: "list", body: { text },
          action: { button: label, sections: [{ rows: choices.map((c) => ({ id: c.id, title: c.title, description: c.description })) }] },
        },
      });
      return true;
    },

    driveFile: async (to, file) => {
      say(to, "file", { ref: `drive:${file.id}`, name: file.name, folder: file.folder ?? null, size: file.size ?? null });
      const niceName = file.name.replace(/\.[^.]+$/, "");
      logCrm(to, docPayload(to, file.name, `Here is ${niceName} 📄`));
      return true;
    },

    // Same argument order as sendPdfBuffer / sendDocument in lib/channel.js.
    generatedFile: async (to, buffer, filename, caption) => {
      const id = crypto.randomUUID();
      const mime = mimeFromName(filename);
      const dir = generatedDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, id);
      fs.writeFileSync(file, buffer);
      try {
        db.prepare("INSERT INTO generated_files (id, user, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(id, String(to), filename, mime, buffer.length, now());
      } catch (err) {
        fs.rmSync(file, { force: true });
        throw err;
      }
      say(to, "file", { ref: `gen:${id}`, name: filename, mime, size: buffer.length, caption: caption || "" });
      logCrm(to, docPayload(to, filename, caption));
      return true;
    },

    pageHits: async (to, prompt, hits) => {
      if (!hits || !hits.length) return false;
      say(to, "pages", {
        prompt,
        hits: hits.map((h) => ({
          ref: `drive:${h.fileId}`, fileId: h.fileId, name: h.name, folder: h.folder ?? null,
          page: h.page, snippet: h.snippet ?? "", size: h.size ?? null,
          pdfTap: pageTapId(h.fileId, h.page, "pdf"),
          imageTap: pageTapId(h.fileId, h.page, "image"),
        })),
      });
      try {
        logCrm(to, textPayload(to, require("./answers.js").formatPageHits(prompt, hits)));
      } catch (e) {
        console.error("CRM logOutbound error (web):", e.message);
      }
      return true;
    },

    // null for another user's file, a missing file, or an id that isn't a uuid.
    readGenerated(id, user) {
      if (typeof id !== "string" || !UUID_RE.test(id)) return null;
      const row = db.prepare("SELECT name, mime FROM generated_files WHERE id = ? AND user = ?").get(id, String(user));
      if (!row) return null;
      const file = path.join(generatedDir(), id);
      if (!fs.existsSync(file)) return null;
      return { path: file, name: row.name, mime: row.mime };
    },

    // Startup housekeeping: drop files older than 30 days, then oldest first
    // until the folder is under GENERATED_MAX_MB (default 200). Saved messages
    // that point at a removed file stay; readGenerated just returns null.
    cleanupGenerated() {
      const dir = generatedDir();
      const drop = (row) => {
        try { fs.rmSync(path.join(dir, row.id), { force: true }); } catch { /* best effort */ }
        db.prepare("DELETE FROM generated_files WHERE id = ?").run(row.id);
      };
      const rows = db.prepare("SELECT id, size, created_at FROM generated_files ORDER BY created_at ASC, rowid ASC").all();
      const cutoff = now() - MAX_AGE_MS;
      const keep = [];
      let removed = 0;
      for (const row of rows) {
        if (row.created_at < cutoff) { drop(row); removed += 1; } else keep.push(row);
      }
      let total = keep.reduce((sum, r) => sum + r.size, 0);
      const limit = maxGeneratedBytes();
      for (const row of keep) {
        if (total <= limit) break;
        drop(row);
        total -= row.size;
        removed += 1;
      }
      return { removed, bytes: total };
    },
  };
}

module.exports = { createWebChannel, mimeFromName };
