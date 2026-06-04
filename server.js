// ============================================================
//  WhatsApp Auto-Responder + Claude Haiku AI Fallback
//  - Google Sheet = control panel (rules + AI knowledge)
//  - Keyword rules answer common questions for FREE
//  - Claude Haiku answers everything else using YOUR knowledge only
// ============================================================

const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");
const FormData = require("form-data");
require("dotenv").config();

const app = express();
app.use(express.json());

const {
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  ANTHROPIC_API_KEY,
  GOOGLE_SHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON, // full service-account JSON as one env var
  DRIVE_FOLDER_ID,             // parent folder the bot searches (recursively)
  PORT = 3000,
} = process.env;

const GRAPH_URL = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ============================================================
//  GOOGLE SHEET ACCESS
//  Sheet has 3 tabs:
//   1) "Rules"     -> Keywords | Match | Type | Caption | FileLink | Filename
//   2) "Knowledge" -> Topic | Info   (the AI's knowledge base)
//   3) "Allowed"   -> Number        (optional whitelist; empty = reply to all)
// ============================================================
let sheetsClient = null;
let driveClient = null;

async function getGoogleAuth() {
  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
}

async function getSheets() {
  if (sheetsClient) return sheetsClient;
  const auth = await getGoogleAuth();
  sheetsClient = google.sheets({ version: "v4", auth: await auth.getClient() });
  return sheetsClient;
}

async function getDrive() {
  if (driveClient) return driveClient;
  const auth = await getGoogleAuth();
  driveClient = google.drive({ version: "v3", auth: await auth.getClient() });
  return driveClient;
}

// Extract a Drive file ID from any Drive link.
function driveFileId(link) {
  if (!link) return null;
  const m = link.match(/\/d\/([a-zA-Z0-9_-]+)/) || link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ---- Recursive listing of all PDFs under the parent folder (cached) ----
// Lets the bot find files by name without any sheet entry. Drop a PDF in the
// folder (or any subfolder) and it becomes requestable automatically.
let fileIndex = { files: [], ts: 0 };
const FILE_CACHE_MS = 2 * 60 * 1000; // refresh at most every 2 minutes

async function listFolderFiles() {
  if (!DRIVE_FOLDER_ID) return [];
  if (Date.now() - fileIndex.ts < FILE_CACHE_MS && fileIndex.files.length) {
    return fileIndex.files;
  }

  const drive = await getDrive();
  const collected = [];
  const toVisit = [DRIVE_FOLDER_ID];

  while (toVisit.length) {
    const folderId = toVisit.shift();
    let pageToken;
    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType)",
        pageSize: 100,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of res.data.files || []) {
        if (f.mimeType === "application/vnd.google-apps.folder") {
          toVisit.push(f.id); // recurse into subfolders
        } else if (f.mimeType === "application/pdf" || /\.(pdf|png|jpe?g)$/i.test(f.name)) {
          collected.push({ id: f.id, name: f.name });
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }

  fileIndex = { files: collected, ts: Date.now() };
  console.log(`🗂️  Indexed ${collected.length} files from Drive folder`);
  return collected;
}

// Find files whose name matches the user's text.
// Normalizes by removing spaces/dashes so "52015", "PAC4A 52015", "pac4a52015" all match.
// Prefers exact base-name matches over partial ones.
function findFilesByName(text, files) {
  const norm = (s) => s.toLowerCase().replace(/[\s\-_.]/g, "");
  const q = norm(text.trim());
  if (!q) return [];

  const scored = [];
  for (const f of files) {
    const base = norm(f.name.replace(/\.[^.]+$/, ""));
    if (base === q) scored.push({ f, rank: 0 });          // exact
    else if (base.includes(q)) scored.push({ f, rank: 1 }); // query inside name
    else if (q.includes(base)) scored.push({ f, rank: 2 }); // name inside query
  }
  if (!scored.length) return [];

  // If any exact matches exist, return only those.
  const best = Math.min(...scored.map((s) => s.rank));
  return scored.filter((s) => s.rank === best).map((s) => s.f);
}

// Simple cache so we don't hit the Sheet on every single message
let cache = { rules: [], knowledge: [], allowed: [], ts: 0 };
const CACHE_MS = 60 * 1000; // refresh at most once per minute

async function loadSheet() {
  if (Date.now() - cache.ts < CACHE_MS && cache.rules.length) return cache;

  const sheets = await getSheets();
  const ranges = ["Rules!A2:F", "Knowledge!A2:B", "Allowed!A2:A"];
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: GOOGLE_SHEET_ID,
    ranges,
  });

  const [rulesRows, knowRows, allowRows] = res.data.valueRanges.map(
    (r) => r.values || []
  );

  const rules = rulesRows
    .filter((r) => r[0]) // must have keywords
    .map((r) => ({
      keywords: (r[0] || "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean),
      matchType: (r[1] || "contains").trim().toLowerCase(),
      type: (r[2] || "text").trim().toLowerCase(),
      caption: r[3] || "",
      fileLink: normalizeDriveLink(r[4] || ""),
      filename: r[5] || "file.pdf",
    }));

  const knowledge = knowRows
    .filter((r) => r[0] || r[1])
    .map((r) => `${r[0] ? r[0] + ": " : ""}${r[1] || ""}`);

  const allowed = allowRows.map((r) => (r[0] || "").replace(/\D/g, "")).filter(Boolean);

  cache = { rules, knowledge, allowed, ts: Date.now() };
  console.log(`🔄 Sheet loaded: ${rules.length} rules, ${knowledge.length} knowledge rows`);
  return cache;
}

// Convert a normal Drive share link into a reliable direct-download link.
// Uses drive.usercontent.google.com with confirm=t, which bypasses the
// "can't scan for viruses" warning page that corrupts downloads.
function normalizeDriveLink(link) {
  if (!link) return "";
  const m = link.match(/\/d\/([a-zA-Z0-9_-]+)/) || link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (link.includes("drive.google.com") && m) {
    return `https://drive.usercontent.google.com/download?id=${m[1]}&export=download&confirm=t`;
  }
  return link; // already direct, or a GitHub/other link
}

// ============================================================
//  MATCHING
// ============================================================
function matchRule(text, rules) {
  const t = text.trim().toLowerCase();
  for (const rule of rules) {
    if (rule.matchType === "exact") {
      if (rule.keywords.some((k) => t === k)) return rule;
    } else {
      if (rule.keywords.some((k) => t.includes(k))) return rule;
    }
  }
  return null;
}

// Levenshtein distance between two strings (for fuzzy "did you mean")
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return d[m][n];
}

// Find keywords closest to the user's text, to suggest when nothing matched.
// Returns up to `limit` suggestion keywords (first keyword of each near rule).
function closestKeywords(text, rules, limit = 5) {
  const full = text.trim().toLowerCase();
  const words = full.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const rule of rules) {
    if (rule.matchType === "exact") continue; // skip the greeting/menu rule
    let best = Infinity;
    for (const kw of rule.keywords) {
      const kwWords = kw.split(/\s+/);
      for (const w of words) {
        // direct containment either way counts as very close
        if (kw.includes(w) || w.includes(kw)) best = Math.min(best, 0.1);
        if (kwWords.some((kwW) => kwW === w)) best = Math.min(best, 0.0);
        const norm = levenshtein(w, kw) / Math.max(w.length, kw.length);
        if (norm < best) best = norm;
      }
      const d2 = levenshtein(full, kw) / Math.max(full.length, kw.length);
      if (d2 < best) best = d2;
    }
    if (best <= 0.5) scored.push({ kw: rule.keywords[0], score: best });
  }
  scored.sort((a, b) => a.score - b.score);
  const seen = new Set();
  const out = [];
  for (const s of scored) {
    if (!seen.has(s.kw)) { seen.add(s.kw); out.push(s.kw); }
    if (out.length >= limit) break;
  }
  return out;
}

// Build a friendly "did you mean" message, or a full menu if nothing is close.
function suggestionMessage(text, rules) {
  const near = closestKeywords(text, rules);
  if (near.length) {
    const list = near.map((k) => `• ${k.toUpperCase()}`).join("\n");
    return `I didn't find an exact match for "${text}". Did you mean one of these? Reply with the code:\n${list}`;
  }
  // nothing close: list all document keywords as a menu
  const all = rules
    .filter((r) => r.matchType !== "exact" && r.type === "document")
    .map((r) => `• ${r.keywords[0].toUpperCase()}`)
    .join("\n");
  return `I couldn't match that. Here are the catalogues you can request — reply with a code:\n${all}`;
}

// ============================================================
//  CLAUDE HAIKU FALLBACK
//  Answers ONLY from the Knowledge tab. Refuses to invent.
// ============================================================
async function askClaude(question, knowledge) {
  if (!ANTHROPIC_API_KEY) return null;

  const knowledgeText = knowledge.join("\n");

  const system = `You are a helpful WhatsApp assistant for a business.
Answer the customer's question using ONLY the information below.
Keep replies short, friendly, and suitable for WhatsApp (2-4 sentences max).
If the information does not contain the answer, reply exactly:
"Let me connect you with a team member who can help with that."
Do NOT make up prices, products, or details.

--- BUSINESS INFORMATION ---
${knowledgeText}
--- END INFORMATION ---`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system,
      messages: [{ role: "user", content: question }],
    });
    return msg.content?.[0]?.text?.trim() || null;
  } catch (err) {
    console.error("Claude error:", err.message);
    return null;
  }
}

// ============================================================
//  SENDING
// ============================================================
async function sendText(to, body) {
  return send(to, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { preview_url: true, body },
  });
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

// Download a file. Accepts either {link} or {fileId}. For Drive, downloads
// via the Drive API using the service account (reliable, no virus-scan page).
async function downloadBytes({ link, fileId }) {
  const id = fileId || (link ? driveFileId(link) : null);

  if (id) {
    const drive = await getDrive();
    const res = await drive.files.get(
      { fileId: id, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    );
    return Buffer.from(res.data);
  }

  // Non-Drive link: direct HTTP download.
  const r = await axios.get(link, { responseType: "arraybuffer", maxRedirects: 5 });
  return Buffer.from(r.data);
}

async function uploadMedia({ link, fileId, filename }) {
  const buffer = await downloadBytes({ link, fileId });
  const mime = mimeFromName(filename);

  // sanity check: a real PDF starts with "%PDF"
  if (mime === "application/pdf") {
    const sig = buffer.slice(0, 5).toString("utf8");
    if (!sig.startsWith("%PDF")) {
      throw new Error(
        `Downloaded file is not a valid PDF (got ${buffer.length} bytes starting "${sig}"). ` +
        `Check the bot's access to this file.`
      );
    }
  }

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mime });
  form.append("type", mime);

  const up = await axios.post(MEDIA_URL, form, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, ...form.getHeaders() },
  });
  return up.data.id; // media ID
}

// Send a file found in the Drive folder, by its Drive ID.
async function sendDriveFile(to, file) {
  const isImage = /\.(png|jpe?g)$/i.test(file.name);
  const niceName = file.name.replace(/\.[^.]+$/, "");
  const caption = `Here is ${niceName} 📄`;
  try {
    const mediaId = await uploadMedia({ fileId: file.id, filename: file.name });
    if (isImage) {
      return send(to, {
        messaging_product: "whatsapp", to, type: "image",
        image: { id: mediaId, caption },
      });
    }
    return send(to, {
      messaging_product: "whatsapp", to, type: "document",
      document: { id: mediaId, filename: file.name, caption },
    });
  } catch (err) {
    console.error("❌ Drive file send error:", err.response?.data || err.message);
    return sendText(to, `Sorry, I couldn't fetch ${niceName} right now. Please try again or contact us.`);
  }
}

async function sendRule(to, rule) {
  if (rule.type === "document") {
    try {
      const mediaId = await uploadMedia({ link: rule.fileLink, filename: rule.filename });
      return send(to, {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: { id: mediaId, filename: rule.filename, caption: rule.caption },
      });
    } catch (err) {
      console.error("❌ Document upload error:", err.response?.data || err.message);
      return sendText(
        to,
        `Sorry, I couldn't fetch that file right now. Please contact us directly.`
      );
    }
  }
  if (rule.type === "image") {
    try {
      const mediaId = await uploadMedia({ link: rule.fileLink, filename: rule.filename || "image.jpg" });
      return send(to, {
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: { id: mediaId, caption: rule.caption },
      });
    } catch (err) {
      console.error("❌ Image upload error:", err.response?.data || err.message);
      return sendText(to, `Sorry, I couldn't fetch that image right now.`);
    }
  }
  return sendText(to, rule.caption);
}

async function send(to, payload) {
  try {
    await axios.post(GRAPH_URL, payload, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    });
    console.log(`✅ Sent ${payload.type} to ${to}`);
  } catch (err) {
    console.error("❌ Send error:", err.response?.data || err.message);
  }
}

// ============================================================
//  WEBHOOK VERIFY
// ============================================================
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(req.query["hub.challenge"]);
  }
  return res.sendStatus(403);
});

// ============================================================
//  WEBHOOK RECEIVER
// ============================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== "text") return;

    const from = message.from;
    const text = message.text.body;

    const { rules, knowledge, allowed } = await loadSheet();

    if (allowed.length && !allowed.includes(from)) {
      console.log(`Ignored non-allowed: ${from}`);
      return;
    }

    console.log(`📩 ${from}: "${text}"`);

    // 1) Sheet keyword rules first (custom overrides / captions)
    const rule = matchRule(text, rules);
    if (rule) return await sendRule(from, rule);

    // Is this a question, or a short product-code/file request?
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    const looksLikeQuestion =
      /[?]/.test(text) ||
      /\b(what|how|when|where|why|who|which|can|do|does|is|are|hours|open|deliver|price|cost|warranty|install|contact|help)\b/i.test(text) ||
      wordCount >= 4;

    // 2) Folder search by filename (the zero-maintenance path).
    //    Skip for obvious questions so "what do you do" doesn't match a file.
    if (!looksLikeQuestion) {
      const files = await listFolderFiles();
      const hits = findFilesByName(text, files);

      if (hits.length === 1) {
        return await sendDriveFile(from, hits[0]);
      }
      if (hits.length > 1 && hits.length <= 8) {
        const list = hits
          .map((f) => `• ${f.name.replace(/\.[^.]+$/, "")}`)
          .join("\n");
        return await sendText(
          from,
          `I found a few matches — reply with the exact one:\n${list}`
        );
      }
      // many hits: too broad, fall through to suggestion menu
    }

    // 3) Real question -> answer from the Knowledge tab via Claude Haiku
    if (looksLikeQuestion) {
      const aiReply = await askClaude(text, knowledge);
      if (aiReply) return await sendText(from, aiReply);
    }

    // 4) Short code-like input with no file match -> suggest closest sheet codes
    const near = closestKeywords(text, rules);
    if (near.length) {
      return await sendText(from, suggestionMessage(text, rules));
    }

    // 5) Last resort
    if (!looksLikeQuestion) {
      const aiReply = await askClaude(text, knowledge);
      if (aiReply) return await sendText(from, aiReply);
    }
    await sendText(from, suggestionMessage(text, rules));
  } catch (err) {
    console.error("Handler error:", err.message);
  }
});

app.get("/", (_, res) => res.send("WhatsApp AI bot running ✅"));
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
