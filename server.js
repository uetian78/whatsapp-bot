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

async function getSheets() {
  if (sheetsClient) return sheetsClient;
  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  sheetsClient = google.sheets({ version: "v4", auth: await auth.getClient() });
  return sheetsClient;
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

// Convert a normal Drive share link into a direct-download link automatically.
function normalizeDriveLink(link) {
  if (!link) return "";
  const m = link.match(/\/d\/([a-zA-Z0-9_-]+)/) || link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (link.includes("drive.google.com") && m) {
    return `https://drive.google.com/uc?export=download&id=${m[1]}`;
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

async function uploadMedia(fileLink, filename) {
  // 1) download the raw bytes from the link (follows Drive redirects)
  const fileResp = await axios.get(fileLink, {
    responseType: "arraybuffer",
    maxRedirects: 5,
  });
  const buffer = Buffer.from(fileResp.data);
  const mime = mimeFromName(filename);

  // 2) upload to WhatsApp media with the correct content-type
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mime });
  form.append("type", mime);

  const up = await axios.post(MEDIA_URL, form, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, ...form.getHeaders() },
  });
  return up.data.id; // media ID
}

async function sendRule(to, rule) {
  if (rule.type === "document") {
    try {
      const mediaId = await uploadMedia(rule.fileLink, rule.filename);
      return send(to, {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: { id: mediaId, filename: rule.filename, caption: rule.caption },
      });
    } catch (err) {
      console.error("❌ Document upload error:", err.response?.data || err.message);
      // fallback: try the old link method so the user still gets the file
      return send(to, {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: { link: rule.fileLink, filename: rule.filename, caption: rule.caption },
      });
    }
  }
  if (rule.type === "image") {
    try {
      const mediaId = await uploadMedia(rule.fileLink, rule.filename || "image.jpg");
      return send(to, {
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: { id: mediaId, caption: rule.caption },
      });
    } catch (err) {
      console.error("❌ Image upload error:", err.response?.data || err.message);
      return send(to, {
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: { link: rule.fileLink, caption: rule.caption },
      });
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

    // 1) Keyword rules first (free + instant)
    const rule = matchRule(text, rules);
    if (rule) return await sendRule(from, rule);

    // 2) Claude Haiku fallback (answers from Knowledge tab)
    const aiReply = await askClaude(text, knowledge);
    if (aiReply) return await sendText(from, aiReply);

    // 3) Final fallback
    await sendText(from, "Thanks for your message! A team member will reply shortly.");
  } catch (err) {
    console.error("Handler error:", err.message);
  }
});

app.get("/", (_, res) => res.send("WhatsApp AI bot running ✅"));
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
