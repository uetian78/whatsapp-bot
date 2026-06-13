// One-off script: extract FAMILIES + axes from Split Selection.html → split-data.json
const fs = require("fs");
const path = require("path");

const htmlPath = "C:\\Users\\HP\\Desktop\\Split Selection.html";
const html = fs.readFileSync(htmlPath, "utf8");

// Extract everything between <script> and </script> (first script block)
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.error("No script block found"); process.exit(1); }

let js = scriptMatch[1];

// We need to evaluate the data portion safely.
// Strip all function/event/DOM code — keep only const/let/var declarations up through FAMILIES closing.
// Strategy: find the block from start of script to end of FAMILIES closing brace, then eval it.

const famEnd = js.indexOf("'SKM-DCT':");
// find the closing }; after SKM-DCT block
const afterSkm = js.indexOf("};\n// active family", famEnd);
const dataPortion = js.slice(0, afterSkm + 2); // includes the closing };

// Evaluate in a VM context
const vm = require("vm");
const ctx = { module: {}, exports: {} };
const code = dataPortion + "\nmodule.exports = { INDOOR, OUTDOOR, SH_INDOOR, SH_OUTDOOR, FAMILIES };";
try {
  vm.runInNewContext(code, ctx);
} catch(e) {
  console.error("VM eval error:", e.message);
  process.exit(1);
}

const { INDOOR, OUTDOOR, SH_INDOOR, SH_OUTDOOR, FAMILIES } = ctx.module.exports;

// Resolve indoor/outdoor references inside FAMILIES (they're JS variable refs, already resolved by eval)
// Build the JSON output
const out = { INDOOR, OUTDOOR, SH_INDOOR, SH_OUTDOOR, FAMILIES };
fs.writeFileSync(
  path.join(__dirname, "split-data.json"),
  JSON.stringify(out, null, 0)
);
console.log("✅ split-data.json written");
