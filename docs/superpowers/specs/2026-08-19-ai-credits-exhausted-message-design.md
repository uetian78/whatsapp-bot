# AI credits exhausted → premium-plan message

**Date:** 2026-08-19
**Status:** Approved

## Problem

Every Claude call in `server.js` swallows its error identically:

```js
} catch (err) {
  console.error("Claude error:", err.message);
  return null;
}
```

When the Anthropic API key runs out of credit, all five call sites fail in a row on
every single message. The customer sees the generic capabilities menu, the bot burns
five doomed HTTP round-trips per message (slow replies), and nothing anywhere says
why the AI features stopped working.

## Goal

When credits are exhausted, tell the customer that AI answers and smart file search
are premium features currently unavailable, prompt the move to the paid plan, and
point them at the exact-filename path that still works. Keep every non-AI feature
running untouched.

## Non-goals

- Per-customer usage quotas or a free-tier counter. This is about the bot owner's
  Anthropic balance, not per-number metering.
- Admin alerting. Deliberately out of scope; the message is customer-facing only.
- Handling rate limits or auth failures. Those are different conditions with
  different correct responses, and are explicitly excluded from detection.

## Design

### New module: `lib/ai-credits.js`

Owns all billing-state knowledge so `server.js` gains none of its own.

| Export | Behavior |
| --- | --- |
| `isCreditError(err)` | `true` only for genuine exhaustion: a `400` `invalid_request_error` whose message matches `/credit balance is too low/i`, or an error whose `.type` is `billing_error`. |
| `markExhausted()` | Latches the exhausted state with a timestamp. |
| `isExhausted()` | `true` while inside the 10-minute TTL; auto-clears afterwards. |
| `resetCredits()` | Test-only latch reset. |
| `creditsExhaustedMessage(name)` | The customer-facing copy, greeting the account by name. |

`429` (rate limit) and `401` (bad or revoked key) are **not** credit errors. A rate
limit is transient and retrying works; a bad key is an operator problem that must not
be dressed up as a billing message to a customer.

The 10-minute TTL means the bot recovers by itself after a top-up — no redeploy, no
manual reset.

### Touch points in `server.js`

1. **Detect** — each of the five `catch` blocks around `anthropic.messages.create`
   gains one line, `if (isCreditError(err)) markExhausted();`, and otherwise returns
   exactly what it returns today. No behavior change while credits are healthy.
2. **Short-circuit** — each AI helper gains `if (isExhausted()) return null;` at the
   top, so once latched no request leaves the process. This is what removes the
   five-failed-calls-per-message latency.
3. **Surface** — one guard at the top of `sendNotFoundWithSuggestions`. That function
   is the single terminal fallback for all ten miss paths in the router, and the
   AI-dependent tail (filename miss → `aiMatchFile` → `askClaude` →
   `sendNotFoundWithSuggestions` → capabilities menu) drains into it once the
   short-circuits above make each AI step return empty. So the message needs exactly
   one insertion point, not one per route.

### What still works

Everything that never calls Claude, which is most of the bot: exact and substring
filename matching (`lib/find-files-by-name.js` is pure JS), the numbered file-choice
list, VRF / split / chiller / schedule / MTZ selection flows, the welcome menu, CRM
logging, and PDF delivery.

### Message copy

Reaches only **paid** accounts — a free account is caught by the earlier plan check
and gets the upgrade message instead. Since this person already pays, the copy must
not tell them to upgrade:

> Hi *Hassan* 👋
>
> Your AI credits are *0* — premium search features are paused until credits are
> added.
>
> *OR*
>
> Type the exact file name to get it (for example "APMR-A" or "ACMR IOM").

### Error handling

The latch fails safe. If `isCreditError` ever misjudges, the worst case is the
premium message showing for ten minutes while credits are actually fine. It can never
block file delivery or any deterministic feature, because those paths do not consult
the latch.

## Testing

`tests/ai-credits.test.js`, in the existing `node --test` style. Pure functions, no
network:

- A real credit-exhaustion error shape is detected and latches.
- A `429` rate-limit error is not a credit error.
- A `401` auth error is not a credit error.
- A `billing_error` type is detected.
- `isExhausted()` is true before the TTL and false after it.

## Known limitation

The credits are the bot owner's, not the customer's, so "Your AI credits are 0" may
read to a paying customer as though they personally need to top something up, and
prompt them to ask the owner how. The wording was chosen deliberately by the owner;
changing it is a one-line edit to `creditsExhaustedMessage()`.
