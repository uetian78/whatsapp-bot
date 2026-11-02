// WhatsApp adapter for the send facade (lib/channel.js): each method is a thin
// forward to lib/wa.js. wa is read at call time (wa.sendText, not a captured
// copy) so the replay harness, which replaces those exports, still intercepts.
const wa = require("./wa.js");

const whatsappAdapter = {
  name: "whatsapp",
  typing: (messageId) => wa.markReadWithTyping(messageId),
  text: (to, body) => wa.sendText(to, body),
  longText: (to, body) => wa.sendLongText(to, body),
  buttons: (to, text, buttons) => wa.sendButtons(to, text, buttons),
  list: (to, text, label, rows) => wa.sendList(to, text, label, rows),
  driveFile: (to, file) => wa.sendDriveFile(to, file),
};

module.exports = { whatsappAdapter };
