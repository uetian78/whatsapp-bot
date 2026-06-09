# VRF skill → WhatsApp bot integration

Two Render services. The Node bot does conversation + Drive. The Python sidecar
runs your VRF skill engine unchanged.

```
WhatsApp ──> Node bot (existing) ──HTTP──> Python sidecar (new) ──> xlsx + summary
                  │                                                      │
                  └── upload xlsx to Drive ──> reply: summary + link  <──┘
```

## Files

For Claude Code: start with `CLAUDE_CODE_BRIEF.md` — it has the full task list.
`.env.example` lists every environment variable.

Sidecar (deploy as its own Render service):
- `app.py` — FastAPI wrapper. `/health`, `/select`.
- `engine/` — your skill scripts, UNCHANGED (`vrf_data.py`, `engine.py`, `build_boq.py`).
- `requirements.txt`, `Dockerfile`.

Node client (drop into your existing bot repo):
- `node-client/vrfClient.js`   — calls the sidecar, formats the WhatsApp reply.
- `node-client/vrfIntake.js`   — guided flow + xlsx parse + image/PDF->rows via Claude.
- `node-client/vrfHandler.js`  — ties intake -> engine -> Drive -> reply, with a
  yes/no confirmation after image/PDF extraction.

## Deploy the sidecar

1. New repo (or subfolder) with `app.py`, `engine/`, `requirements.txt`, `Dockerfile`.
2. Render → New → Web Service → Docker. Same region as the bot.
3. Env var: `VRF_API_KEY` = a long random string.
4. Deploy. Confirm: `GET https://<sidecar>.onrender.com/health` → `{"ok":true}`.

Free Render services sleep; first call after idle is slow. Tell colleagues the
first selection of the day takes ~30s, or use a paid instance / cron ping.

## Wire the Node bot

1. Copy `node-client/*.js` into the bot. `npm i xlsx`.
2. Env vars on the bot: `VRF_SIDECAR_URL`, `VRF_API_KEY` (same value as sidecar),
   `ANTHROPIC_API_KEY` (only for image/PDF intake).
3. In `vrfHandler.js`, replace the two stubs (`sendWhatsApp`, `uploadToDrive`)
   with your existing functions.
4. In your keyword router: on `vrf` → `onVrfKeyword(userId)`. While a user is in
   a vrf session → `onVrfMessage(userId, text, attachment)`.

## Privacy / security

- Catalogue stays server-side in the private sidecar repo. Users never see it.
- `VRF_API_KEY` gates the sidecar; only the bot has it. Keep both in Render env
  vars, never in the repo.
- No prices stored anywhere. Output BOQ has a blank Prices tab the user fills;
  totals repopulate via VLOOKUP.
- Image/PDF intake sends the schedule to the Anthropic API for extraction only.
  For confidential schedules, prefer xlsx intake (stays fully local, no API call).

## Extraction model + confirmation

- Default extractor is **Haiku 4.5** (`claude-haiku-4-5-20251001`) — cheap and
  adequate for transcription. Override per `.env.example` if field photos are
  messy (bump the image path to Sonnet 4.6).
- After image/PDF extraction the bot shows a **confirmation** (line count, total
  units, systems, kW, sample rows) and waits for `yes`/`no` before building. This
  catches misreads regardless of model. xlsx/typed input skips the extra confirm;
  the engine summary is the check.

## Updating the catalogue

Regenerate `engine/vrf_data.py` from the Toshiba Excel, redeploy the sidecar.
The bot needs no change.
