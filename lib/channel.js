// ============================================================
//  Send facade: server.js replies through whichever channel is
//  handling the current message (WhatsApp now, the web chat later).
//
//  The channel rides on AsyncLocalStorage, like lib/accounts.js:
//  different users are handled concurrently, so a module-level
//  "current channel" would let one reply land in another's chat.
//
//  Adapter contract (an object):
//    name                        "whatsapp" | ...
//    typing(messageId)           show "typing…" / mark read (best effort)
//    text(to, body)
//    longText(to, body)          body may exceed one message
//    buttons(to, text, buttons)  [{ id, title }]
//    list(to, text, label, rows) [{ id, title, description? }]
//    driveFile(to, file)         a Drive index entry { id, name, ... }
//    generatedFile(to, buffer, filename, caption)
//    pageHits(to, prompt, hits)  PDF page results [{ fileId, name, folder, page, snippet }];
//                                resolves true when something was sent
//  Every call returns a promise; the adapter's result is passed back as is.
// ============================================================
const { AsyncLocalStorage } = require("node:async_hooks");

const store = new AsyncLocalStorage();

function runWithChannel(adapter, fn) {
  return store.run({ adapter }, fn);
}

function currentChannel() {
  return store.getStore()?.adapter || null;
}

function channelOrThrow() {
  const adapter = currentChannel();
  if (!adapter) throw new Error("No channel: a reply can only be sent inside runWithChannel()");
  return adapter;
}

// async, so "outside a channel" is a rejected promise, never a sync throw.
const sendText = async (to, body) => channelOrThrow().text(to, body);
const sendLongText = async (to, body) => channelOrThrow().longText(to, body);
const sendButtons = async (to, text, buttons) => channelOrThrow().buttons(to, text, buttons);
const sendList = async (to, text, label, rows) => channelOrThrow().list(to, text, label, rows);
const sendDriveFile = async (to, file) => channelOrThrow().driveFile(to, file);
const sendPdfBuffer = async (to, buffer, filename, caption) => channelOrThrow().generatedFile(to, buffer, filename, caption);
const sendDocument = async (to, buffer, filename, caption) => channelOrThrow().generatedFile(to, buffer, filename, caption);
const sendPageHits = async (to, prompt, hits) => channelOrThrow().pageHits(to, prompt, hits);
const showTyping = async (messageId) => channelOrThrow().typing(messageId);

module.exports = {
  runWithChannel, currentChannel,
  showTyping,
  sendText, sendLongText, sendButtons, sendList, sendDriveFile, sendPdfBuffer, sendDocument, sendPageHits,
};
