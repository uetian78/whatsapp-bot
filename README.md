# WhatsApp AI Responder — Setup Guide
### Keyword rules + Claude Haiku, all controlled by ONE Google Sheet

**Cost:** ~$0–5/mo hosting + pennies for AI. Replies within 24h are free from Meta.

---

## THE GOOGLE SHEET (your control panel)

Create one Google Sheet with **3 tabs** named exactly: `Rules`, `Knowledge`, `Allowed`.

### Tab 1 — "Rules" (keyword answers: PDFs, links, text)
Row 1 = headers. Bot reads from row 2 down.

| Keywords | Match | Type | Caption | FileLink | Filename |
|----------|-------|------|---------|----------|----------|
| apmra, catalogue, catalog | contains | document | Here's our APMRA catalogue 📄 | (paste Drive share link) | APMRA_Catalogue.pdf |
| pricelist, rates | contains | document | Our 2026 price list | (paste Drive share link) | Price_List.pdf |
| website, site | contains | text | Visit us 👉 https://yoursite.com | | |
| hi, hello, menu | exact | text | Hi! 👋 Reply CATALOGUE, PRICE, or WEBSITE. | | |

- **Match:** `contains` (keyword anywhere in message) or `exact` (whole message equals keyword)
- **Type:** `document` (PDF), `image`, or `text`
- **FileLink:** just paste the normal Google Drive share link — the bot auto-converts it to a direct download. (GitHub raw links also work.)

### Tab 2 — "Knowledge" (what Claude Haiku knows)
Row 1 = headers. This is the AI's brain for anything keywords don't catch.

| Topic | Info |
|-------|------|
| Business hours | We're open Mon–Sat, 9am to 7pm. Closed Sundays. |
| Delivery | We deliver nationwide. Orders ship within 2–3 business days. |
| Returns | Returns accepted within 14 days with receipt. |
| Products | We supply roofing, HVAC, and restoration materials for contractors. |
| Contact | Call us at +XX-XXX-XXXXXXX or email info@yoursite.com |

Add as many rows as you like. To teach the bot something new, just add a row.

### Tab 3 — "Allowed" (optional whitelist)
Leave **empty** to reply to everyone. To restrict, list numbers (country code, no +):

| Number |
|--------|
| 923001234567 |

---

## STEP 1 — Get the Sheet ID
From your Sheet URL:
`https://docs.google.com/spreadsheets/d/`**`THIS_LONG_ID`**`/edit`
That bold part = `GOOGLE_SHEET_ID`.

## STEP 2 — Create a Google Service Account (free, gives the bot read access)
1. Go to https://console.cloud.google.com → create a project (or use one).
2. **APIs & Services → Library →** enable **Google Sheets API**.
3. **APIs & Services → Credentials → Create Credentials → Service Account.**
4. Create it → open it → **Keys → Add Key → JSON.** A `.json` file downloads.
5. Open the JSON, find the `client_email` (looks like `...@...iam.gserviceaccount.com`).
6. **Share your Google Sheet** with that email (Viewer access) — like sharing with a person.
7. Paste the **entire JSON file content** as the `GOOGLE_SERVICE_ACCOUNT_JSON` env var (one line).

## STEP 3 — Get your Anthropic API key
1. https://console.anthropic.com → **API Keys → Create Key.**
2. Add some credit (a few dollars lasts a very long time at Haiku prices).
3. Use it as `ANTHROPIC_API_KEY`.

## STEP 4 — Meta WhatsApp (same as before)
Get `WHATSAPP_TOKEN` and `PHONE_NUMBER_ID` from the Meta WhatsApp dashboard.
Invent any `VERIFY_TOKEN` string.

## STEP 5 — Deploy on Render
1. Push this folder to GitHub.
2. render.com → New → Web Service → connect repo.
3. Build: `npm install`  •  Start: `npm start`
4. Add ALL env vars from `.env.example`.
5. Deploy → get your URL `https://yourbot.onrender.com`.

## STEP 6 — Connect webhook in Meta
- Callback URL: `https://yourbot.onrender.com/webhook`
- Verify token: your `VERIFY_TOKEN`
- Subscribe to the `messages` field.

## STEP 7 — Test
- Send `catalogue` → get the PDF (keyword rule).
- Send `what are your delivery times?` → Claude Haiku answers from your Knowledge tab.
- Send something off-topic → "A team member will reply shortly."

---

## How it decides what to send
1. **Keyword match?** → send that PDF/link/text (free, instant).
2. **No match?** → Claude Haiku answers using ONLY your Knowledge tab.
3. **Claude can't answer from your info?** → polite handoff message.

## Cost per AI answer
Claude Haiku 4.5: ~$1 per million input tokens, ~$5 per million output.
A short FAQ reply ≈ a fraction of a cent. 1,000 AI replies ≈ under $2.

## To add content later (no code, no redeploy)
- **New PDF:** upload to Drive → add a row in `Rules` with the link.
- **New fact for the AI:** add a row in `Knowledge`.
- **Restrict numbers:** add to `Allowed`.
Changes go live within ~1 minute (cache refresh).
