# Bot Sender — Android app to send WhatsApp messages as the bot

**Date:** 2026-09-21
**Status:** Approved design

## Goal

A native Android app that lets the owner send a WhatsApp message **from the bot's
business number** to a chosen phone number, with optional AI polishing of the
draft, instead of asking Claude to send it.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Sender identity | The bot's Cloud API number (via the existing Render server) |
| Recipient source | Allowed tab (Google Sheet) + favourites saved in the app + free-typed number |
| Drafting | Manual text; optional **Polish with AI** button (Claude Haiku) |
| Language | English / Arabic toggle for polishing |
| Outside 24h window | Show a clear error only (no templates for now) |
| App tech | Native Kotlin + Jetpack Compose APK, sideloaded |
| Auth | `SENDER_PIN` secret on Render, sent as a header by the app |

## Out of scope (YAGNI)

Templates, phone-contact picker, broadcast to many, send history, Play Store.

## Architecture

```
Android app ──HTTPS + X-Sender-Pin──▶ Render server (server.js)
                                        ├─ GET  /api/sender/contacts  → loadSheet().accounts
                                        ├─ POST /api/sender/polish    → Claude Haiku
                                        ├─ POST /api/sender/send      → Graph API /messages
                                        └─ GET  /api/sender/status/:id ← webhook statuses
Meta webhook ──statuses──▶ POST /webhook ──▶ sender status store
```

### Why a status endpoint

The Cloud API accepts a free-form message synchronously (HTTP 200 + `wamid`)
even when the recipient is outside the 24-hour customer-service window. The
rejection (`error.code 131047`, "Re-engagement message") arrives asynchronously
as a `statuses[].status = "failed"` webhook event. The server therefore records
statuses per `wamid` and the app polls for the outcome.

## Server components (WhatsAppBot repo)

### `lib/sender-api.js` (new)

Factory `createSenderRouter({ pin, loadAccounts, polish, sendMessage, statusStore })`
returning an Express router. Dependencies are injected so the router is unit
testable without network.

- **Auth middleware:** every route requires header `X-Sender-Pin` equal to
  `SENDER_PIN` (constant-time compare). Missing/empty `SENDER_PIN` env → all
  routes return `503 {error:"sender_disabled"}`. Wrong PIN → `401`.
- `GET /contacts` → `{ contacts: [{ number, name }] }` sorted by name, from the
  Allowed tab accounts map.
- `POST /polish` body `{ text, language: "en"|"ar", instruction? }` →
  `{ draft }`. Empty text → `400`. AI unavailable (no key / exhausted / credit
  error) → `503 {error:"ai_unavailable", message}`.
- `POST /send` body `{ to, text }` → normalises `to` to digits; rejects numbers
  shorter than 8 digits or empty text (`400`); text over 4096 chars → `400`.
  On Graph success → `{ ok:true, id: wamid }`. On Graph error →
  `502 {ok:false, code, message}` (and `outside_window` flag when code 131047).
- `GET /status/:id` → `{ status: "pending"|"sent"|"delivered"|"read"|"failed", code?, outsideWindow? }`.

### `lib/sender-status.js` (new)

In-memory `Map(wamid → {status, code, ts})` with 1-hour TTL.
`record(statusEvent)` from the webhook, `get(id)`. Status precedence never
downgrades (read > delivered > sent; failed is terminal).

### `lib/sender-polish.js` (new)

`polishDraft(anthropic, { text, language, instruction })` → string. Model
`claude-haiku-4-5-20251001`, max_tokens 600. System prompt: rewrite the user's
note as a clear, polite, concise WhatsApp message in the requested language;
output only the message text; keep facts, numbers, names unchanged; no
invented details. Credit errors call `markExhausted()` like the rest of the bot.

### `lib/wa.js` (edit)

Add `sendTextDetailed(to, body)` → `{ ok, id?, code?, message? }` using the
existing `GRAPH_URL`/token and `crm.logOutbound`. Existing `send()` untouched.

### `server.js` (edit)

- Mount router at `/api/sender`.
- In `POST /webhook`, before the `if (!message) return;`, feed
  `value.statuses` to the sender status store.

### Env

`SENDER_PIN` added on both Render services that run this code.

## Android app (`..\WhatsAppSender`, new standalone repo)

Kotlin, Jetpack Compose, Material 3, minSdk 26, OkHttp + kotlinx.serialization,
`EncryptedSharedPreferences` for URL + PIN, plain SharedPreferences for
favourites.

### Screens

1. **Setup** (first launch or from ⚙️): server URL + PIN, "Test connection"
   calls `/contacts`; saved only on success.
2. **Compose** (main, single screen):
   - Recipient: dropdown (favourites first ⭐, then Allowed contacts) **or**
     "Type number" field. ⭐ toggles favourite for the current number (typed
     numbers can be favourited with an optional name).
   - Message box (multi-line), language toggle **EN / عربي**, **Polish with AI**
     button, optional "Redraft instruction" field, **Undo** restores pre-polish
     text.
   - **Send** → confirm dialog "Send to {name} (+{number})?" → sends → polls
     status every 1.5 s up to 15 s → shows ✅ Delivered/Sent, ⚠️ outside-24h
     message, or ❌ error text. Still "sent" at timeout counts as sent.

### Units

- `PhoneNumbers.normalize(input)` — digits only, validates length ≥ 8.
- `RecipientList.merge(favourites, contacts)` — dedupe by number, favourites first.
- `SenderApi` — thin OkHttp client for the 4 endpoints.
- `ComposeViewModel` — UI state machine (idle / polishing / sending / result).

### Build

Gradle wrapper, `assembleDebug` → `app-debug.apk`, sideloaded by the user.

## Error handling

| Case | App shows |
|---|---|
| Wrong PIN (401) | "PIN rejected — check Settings" |
| Server asleep / network | "Server not reachable (Render may be waking up) — try again" |
| AI unavailable | "AI polishing unavailable: {message}" — manual text still sendable |
| 131047 | "{name} hasn't messaged the bot in the last 24 h. WhatsApp only allows a template message. Ask them to send 'hi' to the bot first." |
| Other Graph error | "WhatsApp rejected the message: {message} (code {code})" |

## Testing

- **Server:** `tests/sender-api.test.js`, `tests/sender-status.test.js`,
  `tests/sender-polish.test.js` (node:test, fakes injected — no network).
- **App:** JVM unit tests for `PhoneNumbers` and `RecipientList`.
- **E2E:** deploy, install APK, send one message to the owner's own number.
