// WhatsApp adapter for the send facade (lib/channel.js): each method is a thin
// forward to lib/wa.js. wa is read at call time (wa.sendText, not a captured
// copy) so the replay harness, which replaces those exports, still intercepts.
const wa = require("./wa.js");
const { formatPageHits } = require("./answers.js");

const isPdf = (filename) => /\.pdf$/i.test(filename || "");

const whatsappAdapter = {
  name: "whatsapp",
  typing: (messageId) => wa.markReadWithTyping(messageId),
  text: (to, body) => wa.sendText(to, body),
  longText: (to, body) => wa.sendLongText(to, body),
  buttons: (to, text, buttons) => wa.sendButtons(to, text, buttons),
  list: (to, text, label, rows) => wa.sendList(to, text, label, rows),
  driveFile: (to, file) => wa.sendDriveFile(to, file),
  // PDF page results go out as one plain text message for now.
  pageHits: async (to, prompt, hits) => {
    if (!hits || !hits.length) return false;
    await wa.sendLongText(to, formatPageHits(prompt, hits));
    return true;
  },
  // Both used to be separate WhatsApp calls: PDFs went through sendPdfBuffer,
  // everything else (the VRF xlsx) through sendDocument. Kept as they were.
  generatedFile: (to, buffer, filename, caption) =>
    isPdf(filename) ? wa.sendPdfBuffer(to, buffer, filename, caption) : wa.sendDocument(to, buffer, filename, caption),
};

module.exports = { whatsappAdapter };
