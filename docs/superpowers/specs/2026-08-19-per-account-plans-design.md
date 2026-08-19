# Per-account plans: paid numbers get AI, free numbers get an upgrade prompt

**Date:** 2026-08-19
**Status:** Implemented
**Builds on:** [AI credits exhausted → premium-plan message](./2026-08-19-ai-credits-exhausted-message-design.md)

## Problem

The bot serves five WhatsApp numbers (the Meta test-number cap for an unverified
business). Each is a separate account, but the bot treats them identically: everyone
gets AI answers and AI file search, so every number spends Anthropic credit.

There is no way to say "this number pays, that one doesn't", and replies are
impersonal — the only name available is whatever the person set as their WhatsApp
profile name.

## Goal

- A number may use the Claude-backed features **only** if it is marked paid.
- A free number gets a clear upgrade message instead of a dead end.
- Replies greet people by the name *you* control, not their profile name.

## Non-goals

- Per-account document sets. Every account still sees the whole Drive index.
- Usage quotas or metering. Plan is a binary flag, not a counter.
- Anything about people outside the five — Meta refuses delivery to unregistered
  numbers (error `131030`), so no reply to them is possible.

## Design

### Sheet schema

`Allowed!A2:A` widens to `Allowed!A2:C`:

| A — number | B — name | C — plan |
| --- | --- | --- |
| 974xxxxxxxx | Hassan | paid |
| 974yyyyyyyy | Ali | free |

Additive and backwards compatible: rows that only fill column A still parse, and a
plan is changed by typing in the sheet — no redeploy. The sheet cache refreshes every
60s, so a change takes effect within a minute.

### New module: `lib/accounts.js`

| Export | Behavior |
| --- | --- |
| `parseAccounts(rows)` | Sheet rows → `Map(number → { number, name, paid })`. Rows without a number are skipped. |
| `isPaidPlan(value)` | Tolerant of hand-typed values: `paid`, `premium`, `yes`, `y`, `true`, `1`, `pro`, any case. Everything else, **including blank**, is free. |
| `normalizeNumber(value)` | Digits only — same rule the existing allowlist already used. |
| `runWithAccount` / `currentAccount` / `aiAllowed` | Per-request account context. |
| `freePlanMessage(name)` | The free-account copy, greeting by name. |

### Why AsyncLocalStorage

`aiMatchSeriesFile` is reached three calls deep (`resolveSeriesFile` →
`fallbackResolve` → `aiMatchSeriesFile`) with no phone number in scope. Two rejected
alternatives:

- **Thread a flag through the signatures** — forces billing concerns into several
  functions that have nothing to do with billing, and any future AI call site added
  without the parameter silently bypasses the gate.
- **A module-level "current user" variable** — actively wrong. `enqueue` serializes
  per user but runs *different* users concurrently, so two accounts would overwrite
  each other at every `await`.

`AsyncLocalStorage` (Node stdlib) pins the account to the request's async context. It
follows the request through every `await` and nested call, so the gate holds
everywhere by construction, including at call sites added later. A concurrency test
covers the leak case directly.

### Touch points in `server.js`

1. `loadSheet()` reads `Allowed!A2:C` and builds the accounts map. `allowed` becomes
   `[...accounts.keys()]`, which is byte-identical to the previous expression, so the
   existing gate is unchanged.
2. The `enqueue` callback resolves the account and wraps the handler in
   `runWithAccount(...)`. `loadSheet()` is cached, so the lookup is free.
3. All five AI helpers extend their guard to `... || !aiAllowed()`. A free number
   therefore makes **zero** Claude calls — the saving is real, not just a hidden reply.
4. `sendNotFoundWithSuggestions` — the single terminal fallback for all ten miss
   paths — sends `freePlanMessage(name)` for a free account, and the existing credits
   message when the balance is dry. Two causes, two messages, one insertion point.
5. `profileName` prefers `currentAccount()?.name` over the WhatsApp profile name.

### Precedence

Free-account check runs **before** the credits check. A free user should be told to
upgrade regardless of the owner's balance; a paid user with a dry balance gets the
credits message.

### What free accounts keep

Everything deterministic: exact and substring filename matching, the numbered file
list, VRF / split / chiller / schedule / MTZ selection, the welcome menu, PDF
delivery, CRM logging.

### Default when there is no account

No context, or a number absent from the sheet, means **AI allowed**. With an empty
Allowed tab the bot runs open to everyone, which is how it behaved before accounts
existed; defaulting to "free" there would silently disable AI for every existing
deployment.

## Testing

`tests/accounts.test.js` (9 tests): plan-value spellings; blank plan → free; number
normalization; `parseAccounts` on empty/null ranges; paid vs free entitlement; the
no-context default; **concurrent accounts not leaking across awaits**; message copy
with and without a name.

## Deploy note

Column C must be filled in before this ships. A blank plan means free, so any number
left blank loses AI on the first request after deploy. Mark the paying numbers `paid`
in the sheet first.
