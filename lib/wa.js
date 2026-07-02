// ============================================================
//  WhatsApp Cloud API transport: send text/buttons/lists/docs,
//  media upload/download, read receipts + typing indicator.
// ============================================================
const axios = require("axios");
const FormData = require("form-data");
const crm = require("../crm.js");
const { downloadBytes } = require("./google.js");
const { MENU_HINT } = require("../menu.js");

const { WHATSAPP_TOKEN, PHONE_NUMBER_ID } = process.env;
const GRAPH_URL = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

const NOT_FOUND_MSG = "Cannot find requested file — Email hassan.saleem@mannai.com.qa to get the required file.\n\n" + MENU_HINT;

// WhatsApp's Graph API rejects document/image uploads over 100 MB (HTTP 413).
// Splitting large PDFs into parts was tried and reverted — pdf-lib's full
// in-memory parse of a 119 MB file OOM-killed the Render container and took
// the whole bot down. Until a memory-safe splitting approach exists, the
// correct behavior is an honest message, never a raw Drive link.
const WHATSAPP_MAX_FILE_BYTES = 100 * 1024 * 1024;
function fileTooLargeMessage(filename) {
  return `Sorry, *${filename}* is too large to send via WhatsApp (file exceeds the 100 MB limit). Please contact hassan.saleem@mannai.com.qa to request this file directly.`;
}

async function sendText(to, body) {
  return send(to, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { preview_url: true, body },
  });
}

// Send a long body in order, split on line breaks to stay under WhatsApp's
// 4096-char message limit (used for full unit lists).
async function sendLongText(to, body, limit = 3800) {
  if (!body) return;
  if (body.length <= limit) return await sendText(to, body);
  const lines = body.split("\n");
  let chunk = "";
  for (const line of lines) {
    if (chunk && (chunk.length + 1 + line.length) > limit) {
      await sendText(to, chunk);
      chunk = line;
    } else {
      chunk = chunk ? chunk + "\n" + line : line;
    }
  }
  if (chunk) await sendText(to, chunk);
}

// Send up to 3 tappable reply buttons. buttons = [{id, title}, ...].
// Titles are capped at 20 chars (WhatsApp limit).
function buildButtonsPayload(to, bodyText, buttons) {
  // WhatsApp rejects the whole message (#131009 "Duplicate button title") if any
  // two buttons share a title. Titles are capped at 20 chars, so names that only
  // differ past char 20 collide once trimmed. Disambiguate with a " (n)" suffix.
  const seen = new Map();
  const trimmed = buttons.slice(0, 3).map((b) => {
    let title = (b.title || "").slice(0, 20);
    const count = seen.get(title) || 0;
    if (count > 0) {
      const suffix = ` (${count + 1})`;
      title = title.slice(0, 20 - suffix.length) + suffix;
    }
    seen.set((b.title || "").slice(0, 20), count + 1);
    return { type: "reply", reply: { id: b.id, title } };
  });
  return {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: { type: "button", body: { text: bodyText.slice(0, 1024) }, action: { buttons: trimmed } },
  };
}
async function sendButtons(to, bodyText, buttons) {
  return send(to, buildButtonsPayload(to, bodyText, buttons));
}

// Interactive list message: one section, up to 10 tappable rows. Better UX
// than "reply with a number" for 4-10 options. rows: [{id, title, description?}].
function buildListPayload(to, bodyText, buttonLabel, rows) {
  return {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "list",
      body: { text: (bodyText || "").slice(0, 4096) },
      action: {
        button: (buttonLabel || "Choose").slice(0, 20),
        sections: [{
          rows: rows.slice(0, 10).map((r) => ({
            id: String(r.id).slice(0, 200),
            title: (r.title || "").slice(0, 24),
            ...(r.description ? { description: String(r.description).slice(0, 72) } : {}),
          })),
        }],
      },
    },
  };
}
async function sendList(to, bodyText, buttonLabel, rows) {
  return send(to, buildListPayload(to, bodyText, buttonLabel, rows));
}

// Mark the inbound message read and show a typing indicator. The indicator
// clears when we send a reply (or after ~25s). Fire-and-forget: a failure
// here must never affect the actual reply.
async function markReadWithTyping(messageId) {
  if (!messageId) return;
  try {
    await axios.post(GRAPH_URL, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("typing-indicator error:", err.response?.data?.error?.message || err.message);
  }
}

// Download a file (e.g. from Google Drive) and re-upload it to WhatsApp's
// media endpoint with the correct content-type. WhatsApp then labels it
// correctly (e.g. .pdf) instead of a generic .bin. Returns a media ID.
const MEDIA_URL = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`;

const EXT_MIME = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function mimeFromName(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return EXT_MIME[ext] || "application/octet-stream";
}

// Sanity check: a real PDF starts with "%PDF". Throws if filename says PDF
// but the downloaded bytes say otherwise (e.g. an HTML error page served
// instead of the file, due to a permissions problem).
function validatePdfBuffer(buffer, filename) {
  const mime = mimeFromName(filename);
  if (mime !== "application/pdf") return;
  const sig = buffer.slice(0, 5).toString("utf8");
  if (!sig.startsWith("%PDF")) {
    throw new Error(
      `Downloaded file is not a valid PDF (got ${buffer.length} bytes starting "${sig}"). ` +
      `Check the bot's access to this file.`
    );
  }
}

async function uploadMedia({ link, fileId, filename }) {
  const buffer = await downloadBytes({ link, fileId });
  validatePdfBuffer(buffer, filename);
  const mime = mimeFromName(filename);

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mime });
  form.append("type", mime);

  const up = await axios.post(MEDIA_URL, form, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, ...form.getHeaders() },
  });
  return up.data.id; // media ID
}

// Download an inbound WhatsApp media object by its media id -> bytes.
// Two-step per Meta Cloud API: (1) GET the media metadata to obtain a short-
// lived URL, (2) GET that URL with the same bearer token.
async function downloadWhatsAppMedia(mediaId) {
  const meta = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const url = meta.data?.url;
  const mediaType = meta.data?.mime_type || "application/octet-stream";
  if (!url) throw new Error("media url not returned by WhatsApp");
  const bin = await axios.get(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: "arraybuffer",
    maxRedirects: 5,
  });
  return { buffer: Buffer.from(bin.data), mediaType };
}

// Upload a raw buffer (e.g. a generated xlsx) to WhatsApp media. Returns a media id.
// Buffer variant of uploadMedia (which downloads-then-uploads from Drive).
async function uploadMediaBuffer(buffer, filename) {
  const mime = mimeFromName(filename);
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mime });
  form.append("type", mime);
  const up = await axios.post(MEDIA_URL, form, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, ...form.getHeaders() },
  });
  return up.data.id;
}

// Send a generated buffer to a user as a WhatsApp document.
async function sendDocument(to, buffer, filename, caption) {
  const mediaId = await uploadMediaBuffer(buffer, filename);
  return send(to, {
    messaging_product: "whatsapp", to, type: "document",
    document: { id: mediaId, filename, caption: caption || "" },
  });
}

// Send a file found in the Drive folder, by its Drive ID.
async function sendDriveFile(to, file) {
  const isImage = /\.(png|jpe?g)$/i.test(file.name);
  const niceName = file.name.replace(/\.[^.]+$/, "");
  const caption = `Here is ${niceName} 📄`;

  if (isImage) {
    try {
      const mediaId = await uploadMedia({ fileId: file.id, filename: file.name });
      return send(to, {
        messaging_product: "whatsapp", to, type: "image",
        image: { id: mediaId, caption },
      });
    } catch (err) {
      console.error("❌ Drive file send error:", err.response?.data || err.message);
      if (err.response?.status === 413) {
        return sendText(to, fileTooLargeMessage(file.name));
      }
      return sendText(to, NOT_FOUND_MSG);
    }
  }

  let buffer;
  try {
    buffer = await downloadBytes({ fileId: file.id });
    validatePdfBuffer(buffer, file.name);
  } catch (err) {
    console.error("❌ Drive file download error:", err.message);
    return sendText(to, NOT_FOUND_MSG);
  }

  try {
    const mediaId = await uploadMediaBuffer(buffer, file.name);
    return send(to, {
      messaging_product: "whatsapp", to, type: "document",
      document: { id: mediaId, filename: file.name, caption },
    });
  } catch (err) {
    console.error("❌ Drive file send error:", err.response?.data || err.message);
    if (err.response?.status === 413 || buffer.length > WHATSAPP_MAX_FILE_BYTES) {
      return sendText(to, fileTooLargeMessage(file.name));
    }
    return sendText(to, NOT_FOUND_MSG);
  }
}

// Upload a locally generated PDF buffer to WhatsApp and send it as a document
// (unlike sendDriveFile, this PDF doesn't exist in Drive — pdfkit built it).
async function sendPdfBuffer(to, pdfBuffer, filename, caption) {
  const fd = new FormData();
  fd.append("messaging_product", "whatsapp");
  fd.append("type", "application/pdf");
  fd.append("file", pdfBuffer, { filename, contentType: "application/pdf" });

  const uploadRes = await axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`,
    fd,
    { headers: { ...fd.getHeaders(), Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );

  return send(to, {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: { id: uploadRes.data.id, filename, caption },
  });
}

async function send(to, payload) {
  crm.logOutbound(to, payload); // CRM: attach this reply to the pending interaction
  try {
    await axios.post(GRAPH_URL, payload, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    });
    console.log(`✅ Sent ${payload.type} to ${to}`);
    return true;
  } catch (err) {
    console.error("❌ Send error:", err.response?.data || err.message);
    return false;
  }
}

module.exports = {
  send, sendText, sendLongText, sendButtons, sendDocument, sendDriveFile, sendPdfBuffer,
  sendList, markReadWithTyping,
  uploadMedia, uploadMediaBuffer, downloadWhatsAppMedia, mimeFromName, validatePdfBuffer,
  buildButtonsPayload, buildListPayload,
  NOT_FOUND_MSG, fileTooLargeMessage, WHATSAPP_MAX_FILE_BYTES,
  GRAPH_URL, MEDIA_URL, EXT_MIME,
};
