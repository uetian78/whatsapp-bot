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
//
//  Nothing makes files any more, so there is no "gen:" ref to write. Older chats
//  may still hold file cards with one: the screen shows them as no longer
//  available and /app/files answers them with the usual notice page. The
//  generated_files table (and any <dataDir>/generated folder) are left as they
//  were; nothing reads or cleans them.
//
//  Every reply is also passed to crm.logOutbound in the payload shape
//  lib/wa.js sends, so the usage log keeps working. A CRM failure never
//  breaks the reply.
// ============================================================
const isImage = (name) => /\.(png|jpe?g)$/i.test(name || "");

const defaultFindLibraryFile = (id) => (process.env.DRIVE_FOLDER_ID ? require("./drive-index.js").getLibraryIndex().findById(id) : null);

function createWebChannel({ conversations, crm, findLibraryFile }) {
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

  // Some paths hand over a Drive file with no size (a direct id). The page needs
  // it to choose between sharing the file and sharing a link, so look it up in
  // the library; unknown stays null. Looked up only when needed, and the real
  // library is only required then, so nothing opens at require time.
  const librarySize = async (id) => {
    try {
      const found = await (findLibraryFile || defaultFindLibraryFile)(id);
      const size = found && Number(found.size);
      return Number.isFinite(size) && found.size !== null && size >= 0 ? size : null;
    } catch (e) {
      console.error("Library size lookup error (web):", e.message);
      return null;
    }
  };

  const say = (to, kind, body) => conversations.append(to, "bot", kind, body);

  const normalizeChoices = (rows) =>
    (rows || []).map((r) => ({ id: String(r.id), title: r.title || "", description: r.description || "" }));

  return {
    name: "web",
    typing: async () => {},

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
      const size = file.size ?? (await librarySize(file.id));
      say(to, "file", { ref: `drive:${file.id}`, name: file.name, folder: file.folder ?? null, size: size ?? null });
      const niceName = file.name.replace(/\.[^.]+$/, "");
      logCrm(to, docPayload(to, file.name, `Here is ${niceName} 📄`));
      return true;
    },
  };
}

module.exports = { createWebChannel };
