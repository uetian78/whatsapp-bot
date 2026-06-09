# VRF Selection over WhatsApp — Design

Date: 2026-06-09
Status: Approved (design)

## Goal

Add a Toshiba SMMSe VRF selection feature to the existing WhatsApp bot. A
colleague triggers it with the exact phrase **"VRF Selection"**, provides a
schedule (typed rows, an xlsx/csv upload, or a photo/PDF), and receives a
single-sheet BOQ workbook (.xlsx) back as a WhatsApp document plus a short text
summary.

The deterministic Python engine (catalogue + selection logic) must run
**unchanged** — all model numbers and capacities come only from the engine's
embedded catalogue; nothing is fabricated. No prices are stored anywhere; the
output ships with a blank Prices tab the user fills (totals repopulate via
VLOOKUP).

## Constraints / decisions

- **Catalogue is already published**, so the engine lives in the bot repo (no
  isolation gymnastics). The `X-API-Key` on the sidecar stays as cheap
  defense-in-depth.
- **Trigger is the exact phrase `VRF Selection`** (case-insensitive, trimmed) —
  not bare `vrf`, not a substring of a longer message. This is a hard
  requirement from the user.
- **Output is delivered as a WhatsApp document directly** (reusing the existing
  MTZ "generate buffer → send as document" pattern), not via a Drive link. The
  bot has no Drive-upload-link function today and we are not adding one.
- **All three intake paths** ship in v1: typed rows, xlsx/csv upload, image/PDF
  (the last via Claude vision with a yes/no confirmation step).
- The engine is Python and must stay byte-for-byte unchanged.

## Architecture

One GitHub repo (`uetian78/whatsapp-bot`), two Render services:

```
WhatsApp ──> Node bot (existing service) ──HTTP /select──> Python sidecar (new service)
                  │                                              │  (engine unchanged)
                  └── send xlsx as WhatsApp document <── xlsx + X-Summary header
```

- **Node bot** — existing Render service, plain Node deploy left untouched.
  Handles the WhatsApp conversation, intake, media download, and file delivery.
- **`vrf-sidecar/`** — new subfolder in the same repo, deployed as a *separate*
  Render Web Service using its Docker runtime (so Python is available there
  without dockerizing the proven Node service). Exposes:
  - `GET /health` → `{"ok": true}`
  - `POST /select` (header `X-API-Key`) → xlsx bytes; engine summary JSON in the
    `X-Summary` response header. Fails closed if `VRF_API_KEY` is unset.

The engine files (`engine/vrf_data.py`, `engine/engine.py`,
`engine/build_boq.py`) and `app.py`, `Dockerfile`, `requirements.txt` come from
the provided integration bundle and are used as-is.

## Components added to the Node bot

Provided modules copied into a `vrf/` folder, with the two stubs wired to the
bot's real functions:

- `vrf/vrfClient.js` — calls the sidecar `/select`, formats the WhatsApp reply
  (`runVrfSelection`, `summaryToWhatsApp`). Used as-is.
- `vrf/vrfIntake.js` — guided typed flow, xlsx/csv parse (SheetJS, deterministic),
  and image/PDF → rows via Claude vision, plus the confirmation text builder.
  Used as-is. Requires `npm i xlsx`.
- `vrf/vrfHandler.js` — orchestrates intake → engine → delivery. Two edits:
  - `sendWhatsApp(userId, text)` → bound to the bot's existing `sendText`.
  - `uploadToDrive(...)` stub is removed; `finishAndSend` instead delivers the
    xlsx as a WhatsApp document (see helpers below) and then sends the summary
    text. The handler keeps its own session `Map` with fields `mode`, `guided`,
    `pending`.

Two new helpers in `server.js`:

- `downloadWhatsAppMedia(mediaId)` — inbound media id → bytes. GET
  `https://graph.facebook.com/v21.0/<mediaId>` (Bearer `WHATSAPP_TOKEN`) to get
  the media URL, then GET that URL (same Bearer) as an arraybuffer. Returns
  `{ buffer, mediaType, filename }`. New, because the bot currently ignores
  non-text messages.
- `uploadMediaBuffer(buffer, filename)` — a buffer variant of the existing
  `uploadMedia` (which only downloads-then-uploads). Uploads raw bytes to the
  WhatsApp media endpoint with the right content-type and returns a media id,
  used to deliver the xlsx as a `type: document` message.

## Webhook router changes (`server.js`)

Today the webhook returns early for any non-text message
(`if (message.type !== "text") return;`, ~line 1040). Changes:

1. **Session-first routing.** Near the MTZ block (~line 1056), before the
   text-only short-circuit: if `vrfSessions.has(from)`, build the attachment
   (if the message is `image`/`document`, download via `downloadWhatsAppMedia`)
   and call `onVrfMessage(from, text, attachment)`. This must run for image and
   document message types, so it sits *before* the `type !== "text"` return.
2. **Trigger.** For text messages, when `vrfSessions.has(from)` is false and the
   trimmed text matches `^vrf selection$` (case-insensitive), call
   `onVrfKeyword(from)` which seeds the session and sends the intro prompt. Bare
   `vrf` and substrings do not trigger.
3. **Session store — single source of truth.** `vrfHandler.js` already exports
   its `sessions` Map (keyed by `userId`). The webhook imports it as
   `vrfSessions` and routes on `vrfSessions.has(from)` — no second session
   object is introduced, so there is no collision with `pendingMtz` /
   `pendingLists` and no sync problem. A `ts` field is added to the session when
   it is created; the webhook sweeps it for a 10-minute timeout (mirroring MTZ)
   and deletes stale sessions with a message before routing.

## Data flow

```
"VRF Selection" → onVrfKeyword → vrfSessions.set(from, …{ts}), intro prompt sent
 ├─ typed rows  → guidedStep loop → done → /select → xlsx
 ├─ xlsx/csv    → downloadWhatsAppMedia → rowsFromWorkbook → /select → xlsx   (deterministic)
 └─ image/PDF   → downloadWhatsAppMedia → rowsFromImageOrPdf (Claude) → confirm (yes/no) → /select → xlsx
xlsx → uploadMediaBuffer → WhatsApp document + summaryToWhatsApp text → session cleared
```

Image/PDF is the only path that calls the Anthropic API (extraction only;
default model Haiku 4.5). The yes/no confirmation catches misreads before the
engine runs. xlsx/typed paths skip the extra confirm — the engine summary is the
check.

## Error handling & session safety

- `pendingVrf[from]` carries a `ts`; a 10-minute timeout clears stale sessions
  with a message, exactly like MTZ.
- Sidecar cold start on the free tier (~30–50s on first call) is covered by the
  "Running selection…" message. Optional later: a cron ping to `/health`.
- Engine errors (`/select` 4xx), extraction parse failures, and unsupported file
  types each surface as a plain WhatsApp message; the session is cleared or
  offered a retry per the existing handler logic.
- The sidecar fails closed: no `VRF_API_KEY` on the server → 500, all requests
  rejected.

## Environment variables (Node bot, Render)

- `VRF_SIDECAR_URL` — sidecar base URL, no trailing slash.
- `VRF_API_KEY` — long random string; identical value on both services.
- `ANTHROPIC_API_KEY` — already present; used for image/PDF extraction.
- `VRF_EXTRACT_MODEL` / `VRF_EXTRACT_MODEL_IMAGE` / `VRF_EXTRACT_MODEL_PDF` —
  optional overrides; default `claude-haiku-4-5-20251001`.

Sidecar service env: `VRF_API_KEY` (same value).

## Dependencies

- Node bot: `npm i xlsx` (SheetJS) for xlsx/csv intake. Node 18+ global `fetch`
  is assumed (already used elsewhere); if not, add `node-fetch` and require it in
  the two client modules.

## Testing

Sidecar (curl):
- `GET /health` → `{"ok": true}`.
- `POST /select` with no key → 401; with key + sample body → xlsx
  (content-type `…spreadsheetml.sheet`) and an `X-Summary` JSON header.

Node bot (WhatsApp, manual):
- Text `VRF Selection` → intro prompt; `pendingVrf` set.
- Typed flow: project name → rows → `done` → receive the xlsx document + summary.
- xlsx upload → receive the xlsx document + summary (no confirm step).
- Image/PDF → confirmation message → `yes` → document; `no` → cancel/retry.
- A non-matching text (e.g. `vrf`, or `please run vrf selection now`) does **not**
  start a VRF session.
- A second user's session does not collide with the first.

## Out of scope (v1)

- Drive archival of the BOQ (direct WhatsApp delivery only).
- Price lists (blank Prices tab only; nothing stored).
- Any change to the engine's selection logic or catalogue contents.
- A `/health` cron ping (noted as an optional follow-up).
