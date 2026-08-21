// ============================================================
//  Google service-account auth + Sheets/Drive clients.
//  Token is minted via axios (NOT gaxios/node-fetch) — see the
//  comments below; do not "simplify" back to the SDK's own flow.
// ============================================================
const crypto = require("crypto");
const axios = require("axios");
const { google } = require("googleapis");

const { GOOGLE_SERVICE_ACCOUNT_JSON } = process.env;

// Parse the service-account credentials from GOOGLE_SERVICE_ACCOUNT_JSON.
// Accepts EITHER raw JSON or a base64-encoded JSON. Base64 is recommended on
// hosting dashboards because it has no quotes/newlines/backslashes to get
// mangled on paste (the private_key's \n is the usual casualty).
function parseServiceAccount() {
  const raw = (GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const creds = JSON.parse(text);
  // If the private key survived as literal "\n" sequences, restore real newlines.
  if (creds.private_key && creds.private_key.includes("\\n")) {
    creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  }
  return creds;
}

// ── Access-token minting via axios (NOT gaxios/node-fetch) ───────────────────
// google-auth-library's own token fetch rides on gaxios 6 → node-fetch 2, whose
// POST handling fails reliably on modern Node with "Invalid response body while
// trying to fetch https://www.googleapis.com/oauth2/v4/token: Premature close".
// gaxios never retries POSTs, so the token exchange can never recover and every
// Drive/Sheets call dies before it starts. We instead sign the JWT ourselves and
// exchange it for an access token over axios (native http — the same transport
// our WhatsApp Graph calls use, which work fine), then hand that token to the
// google SDK so it only ever issues GET API calls. Token cached until ~1 min
// before expiry.
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets", // read rules/knowledge + write CRM log
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");
let googleToken = { value: null, exp: 0 };

async function getGoogleAccessToken() {
  if (googleToken.value && Date.now() < googleToken.exp - 60_000) return googleToken.value;
  const creds = parseServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned =
    b64({ alg: "RS256", typ: "JWT" }) + "." +
    b64({
      iss: creds.client_email,
      scope: GOOGLE_SCOPES,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(creds.private_key, "base64url");
  const jwt = `${unsigned}.${sig}`;

  const res = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 20_000 }
  );
  googleToken = {
    value: res.data.access_token,
    exp: Date.now() + (res.data.expires_in || 3600) * 1000,
  };
  console.log("🔑 Google access token minted (axios), expires in", res.data.expires_in, "s");
  return googleToken.value;
}

// OAuth2 client carrying our self-minted token. We re-set the (cached) token
// before every use so the SDK never attempts its own refresh.
let oauthClient = null;
async function getAuthedClient() {
  const token = await getGoogleAccessToken();
  if (!oauthClient) {
    oauthClient = new google.auth.OAuth2();
    // The googleapis SDK runs every Drive/Sheets call through gaxios 6, whose
    // only server-side transport is node-fetch 2 — and node-fetch 2 fails
    // reliably on this host with "Premature close" (the same bug that broke the
    // token POST, now also seen on the Drive GET once we got past auth). Node 18+
    // ships a working native fetch (undici); point gaxios at it instead. gaxios
    // decodes json via res.text()/.json() and binary via res.arrayBuffer(), both
    // supported by undici's Response; the only unsupported path (responseType
    // "stream") is never used here — all downloads use "arraybuffer".
    const tx = oauthClient.transporter;
    if (tx && tx.instance) {
      tx.instance.defaults = Object.assign({}, tx.instance.defaults, {
        fetchImplementation: globalThis.fetch,
      });
    }
  }
  oauthClient.setCredentials({ access_token: token });
  return oauthClient;
}

// Retry helper for genuine transient blips on the GET API calls.
async function withRetry(fn, attempts = 3, baseDelayMs = 500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
  throw lastErr;
}

async function getSheets() {
  return google.sheets({ version: "v4", auth: await getAuthedClient() });
}

async function getDrive() {
  return google.drive({ version: "v3", auth: await getAuthedClient() });
}

// Extract a Drive file ID from any Drive link.
function driveFileId(link) {
  if (!link) return null;
  const m = link.match(/\/d\/([a-zA-Z0-9_-]+)/) || link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Download a file. Accepts either {link} or {fileId}. For Drive, downloads
// via the Drive API using the service account (reliable, no virus-scan page).
// `exportMime` is set for native Google Docs/Sheets/Slides. Those have no
// stored bytes to download — files.get(alt:"media") returns a 403 for them —
// so they must go through files.export, which renders the document into a
// real format (xlsx/docx/pptx) on Google's side. Everything else is a plain
// download. Export is covered by the drive.readonly scope we already hold.
async function downloadBytes({ link, fileId, exportMime }) {
  const id = fileId || (link ? driveFileId(link) : null);

  if (id) {
    const drive = await getDrive();
    if (exportMime) {
      const res = await drive.files.export(
        { fileId: id, mimeType: exportMime },
        { responseType: "arraybuffer" }
      );
      return Buffer.from(res.data);
    }
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

module.exports = {
  parseServiceAccount, getGoogleAccessToken, getAuthedClient, withRetry,
  getSheets, getDrive, driveFileId, downloadBytes, normalizeDriveLink,
};
