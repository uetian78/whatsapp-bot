// ============================================================
//  Child process that reads one PDF (see readFileInWorker in pdf-text.js).
//  The parent sends { path } of a PDF already on disk; this reads it, sends
//  back { ok: true, pages } or { ok: false, error }, and waits to be stopped.
//  The PDF itself never goes over the message channel. Nothing is printed:
//  the parent drops our stdout/stderr, and pdfjs runs with verbosity 0.
// ============================================================
const fs = require("node:fs");
const { extractPages } = require("./pdf-text.js");

// If the parent goes away, so do we.
process.on("disconnect", () => process.exit(0));

process.on("message", async (msg) => {
  try {
    if (!msg || typeof msg.path !== "string") throw new Error("No PDF path was given");
    const buf = fs.readFileSync(msg.path);
    // pdfjs wants a plain Uint8Array, not a Buffer.
    const pages = await extractPages(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    process.send({ ok: true, pages });
  } catch (err) {
    process.send({ ok: false, error: String((err && err.message) || err).slice(0, 200) });
  }
});
