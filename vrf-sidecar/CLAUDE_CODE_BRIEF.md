# CLAUDE CODE — Implementation Brief: VRF selection over WhatsApp

You are implementing a VRF (Toshiba SMMSe) selection feature for an existing
WhatsApp bot. Most code is already written and tested. Your job is to deploy the
Python sidecar and wire the provided Node modules into the existing CommonJS bot.
Do NOT rewrite the engine or the selection logic.

## Architecture (already decided — do not change)

Two Render services:
- **Python sidecar** (new): FastAPI wrapping the deterministic VRF engine
  unchanged. Endpoints `/health`, `/select`. Auth via `X-API-Key` header.
- **Node bot** (existing): handles WhatsApp conversation, schedule intake, Drive
  upload. Calls the sidecar over HTTP.

```
WhatsApp -> Node bot -> POST /select (sidecar) -> xlsx + summary
                 |                                      |
                 +-- upload xlsx to Drive -> reply  <---+
```

## Hard rules (must not violate)

1. The engine (`engine/vrf_data.py`, `engine/engine.py`, `engine/build_boq.py`)
   is the source of truth and must stay byte-for-byte unchanged. All model
   numbers and capacities come ONLY from `vrf_data.py`. Never fabricate or hardcode
   a model/capacity anywhere else.
2. No prices are stored anywhere. The BOQ ships with a blank Prices tab the user
   fills; totals repopulate via VLOOKUP. Do not add a price list to any repo file.
3. Secrets (`VRF_API_KEY`, `ANTHROPIC_API_KEY`, Drive credentials) live ONLY in
   Render environment variables. Never commit them. Keep both repos private.
4. The sidecar fails closed: if `VRF_API_KEY` is unset on the server, it must
   reject all requests (already implemented — keep it).

## Provided files (already written and tested — use as-is)

Sidecar:
- `app.py`            FastAPI wrapper. Tested: 401 without key, valid xlsx with key.
- `engine/`           The VRF skill scripts, unchanged.
- `requirements.txt`, `Dockerfile`

Node client (copy into the existing bot repo):
- `node-client/vrfClient.js`   Calls sidecar `/select`, formats WhatsApp reply.
- `node-client/vrfIntake.js`   Guided flow + xlsx parse + image/PDF->rows via Claude.
- `node-client/vrfHandler.js`  Orchestrates intake -> engine -> Drive -> reply.

## TASK 1 — Deploy the Python sidecar

1. Put `app.py`, `engine/`, `requirements.txt`, `Dockerfile` in a new private repo
   (or a subfolder of an existing one).
2. Create a Render Web Service, Docker runtime, SAME REGION as the Node bot.
3. Set env var `VRF_API_KEY` to a long random string (generate one).
4. Deploy. Verify `GET https://<sidecar-host>/health` returns `{"ok":true}`.
5. Verify auth: `POST /select` with no key returns 401; with the key + a small
   JSON body returns an xlsx (content-type
   `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`) and an
   `X-Summary` response header containing the JSON summary.

Example test body for `/select`:
```json
{"project":"Test","discount":0.25,
 "rows":[{"type":"ducted","required_kw":6,"qty":2,"system":"S1"},
         {"type":"4 way cassette","required_kw":14,"qty":4,"system":"S2"}]}
```

## TASK 2 — Wire the Node bot

1. Copy `node-client/*.js` into the bot repo (e.g. a `vrf/` folder).
2. `npm i xlsx` (SheetJS) for xlsx/csv intake. Node 18+ has global `fetch`; if the
   bot runs older Node, add `node-fetch` and require it in `vrfClient.js` and
   `vrfIntake.js`.
3. In `vrfHandler.js` replace the two stubs with the bot's real functions:
   - `sendWhatsApp(userId, text)` -> existing outbound text sender.
   - `uploadToDrive(buffer, filename)` -> existing service-account uploader that
     returns a shareable URL. (The bot already uses the Drive service account API
     that bypasses the virus-scan interstitial — reuse that exact path.)
4. Hook into the existing keyword router (the same place SKM/SMMSe/APMR keywords
   are handled):
   - On inbound text equal to (or containing) `vrf` -> `onVrfKeyword(userId)`.
   - While `sessions.get(userId)?.mode === 'vrf'` -> route every inbound message
     (text and any attachment) to `onVrfMessage(userId, text, attachment)`.
   - `attachment` shape expected: `{ base64, mediaType, filename }`. Adapt the
     bot's media download (WhatsApp media id -> bytes) to produce base64 + the
     MIME type. If the bot already downloads media for other flows, reuse it.
5. Make sure the vrf session store does not collide with existing session state.
   `vrfHandler.js` keeps its own in-memory `Map`. If the bot has a shared session
   store you prefer, swap the `Map` for it but keep the same fields
   (`mode`, `guided`, `pending`).

## TASK 3 — Env vars on the Node bot

Set in Render (see `.env.example`):
- `VRF_SIDECAR_URL`   = the sidecar base URL (no trailing slash)
- `VRF_API_KEY`       = SAME value as on the sidecar
- `ANTHROPIC_API_KEY` = only needed for image/PDF intake
- `VRF_EXTRACT_MODEL` = optional; defaults to `claude-haiku-4-5-20251001`
- `VRF_EXTRACT_MODEL_IMAGE` = optional; override just the image path (e.g. set to
  `claude-sonnet-4-6` if field photos are messy). Falls back to VRF_EXTRACT_MODEL.
- `VRF_EXTRACT_MODEL_PDF`   = optional; same idea for PDFs.

Model rationale: Haiku 4.5 is the default extractor (cheap, fine for clean
schedules). Extraction is transcription, not reasoning, so Haiku is adequate. The
confirmation step (below) catches misreads regardless of model. Only bump the
image path to Sonnet if real-world field photos prove unreliable.

## TASK 4 — Confirmation behavior (already coded — verify it works end to end)

For image/PDF intake the handler does NOT build immediately. It:
1. Extracts rows via Claude (Haiku by default).
2. Sends a confirmation: line-item count, total units, system count, total kW,
   and up to 8 sample rows.
3. Waits for `yes` (build) or `no` (cancel).
For xlsx/csv and guided-text intake there is no extra confirm step — the engine
summary returned after build is the check.

Verify: send a photo -> get the confirmation -> reply `yes` -> receive the Drive
link + summary. Reply `no` -> session offers a retry.

## Definition of done

- `/health` returns ok; `/select` enforces the key and returns xlsx + summary.
- `vrf` keyword starts a session for any of the ~20 colleagues.
- All three intake paths work: typed rows, xlsx/csv upload, image/PDF (with the
  yes/no confirmation).
- The reply contains the engine summary and a working Drive link.
- No secrets in the repo. Engine files unchanged. No prices stored.

## Notes / gotchas

- Render free tier sleeps after ~15 min idle (cold start ~30-50s on first call).
  For a smoother team experience use the Starter (~$7/mo, always on) or add a
  cron ping to `/health`.
- The bot and sidecar must share a region for fast private traffic.
- `build_boq.py` returns the summary dict directly (the sidecar reads it from the
  function return, not stdout) — don't try to parse stdout.
- Confidential schedules: image/PDF intake sends the file to the Anthropic API.
  Recommend xlsx intake for sensitive projects (fully local, no API call).
