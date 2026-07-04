# Outlook Workflow Log Auto-Filler — Design Spec

**Date:** 2026-07-04
**Status:** Approved by user
**Deliverable location:** `C:\Users\HP\OneDrive - MCL\WorkflowLog\` (new standalone tool; this spec lives in the WhatsAppBot repo only because it hosts the specs directory)

## Problem

Hassan manually fills the "H. Saleem Workflow Log Sheet" (a tab in the shared
`Technica team log sheet.xlsx`) from his Outlook inbox and sent items. The log
stopped being updated in mid-May 2026 because it is tedious. Office IT policy
forbids connecting Outlook to cloud AI connectors, and token cost must be
minimized (target: zero recurring cost).

## Decisions (user-approved)

- **Approach A:** fully local PowerShell script using Outlook COM automation.
  No cloud, no connectors, no AI tokens, nothing to install (PowerShell is
  built into Windows; classic Outlook with the Mannai work profile is
  confirmed present on this PC and COM-registered).
- **Trigger:** desktop shortcut "Update Workflow Log" (on-demand). No
  scheduled task for now.
- **Target file:** the script maintains its **own** workbook
  (`Workflow Log.xlsx`); it does NOT write into the shared team log. The user
  copies rows into the team sheet manually. (The live team file appears to be
  a newer revision — has a "Working Date" column — that is not among the local
  copies; local Desktop and OneDrive-MCL copies are older.)
- **Field derivation:** keyword/lookup rules with yellow-highlight fallback
  for cells the rules can't fill confidently. No AI classification.
- **Initial backfill:** from **May 1, 2026**, so output can be validated
  against the user's real manual entries (rows 1–42 of the H. sheet).

## Components

```
OneDrive - MCL\WorkflowLog\
├── Update-WorkflowLog.ps1    # main script (PowerShell 5.1 compatible)
├── config.json               # editable rules (see below)
├── Workflow Log.xlsx         # output workbook: Inbox | Sent Items | Dashboard
├── state.json                # last-run timestamp + processed conversation keys
└── logs\run-YYYYMMDD.log     # per-run log, plain text
Desktop\Update Workflow Log.lnk  # runs the script; console window shows summary
```

### config.json

- `mailbox`: SMTP of the work account (Hassan.Saleem@mannai.com.qa)
- `sinceDate`: "2026-05-01" (first-run floor; later runs use state.json)
- `salesReps`: map of sender email → display name (seeded by scanning actual
  mailbox senders: Ajay, Dina, Zahran, Ahmed Sherien, Hassan Mustafa,
  Eckrima, Rawan Sobh, Hussein, …). Unknown senders → sender display name,
  highlighted.
- `taskRules`: ordered list of `{keywords[], code}` matched against subject
  (case-insensitive). Defaults:
  1. submittal / "MS" / material submittal → `MS`
  2. RTCC / consultant comments / reply to comments → `RTCC`
  3. calendar invite item OR meeting / MOM / minutes → `Meeting`
  4. quotation / pricing / selection / offer / BOQ / quote → `Q`
  First match wins; no match → blank + highlight.
- `ignoreSenders`: substrings (no-reply, newsletter, notifications@, …)
- `internalDomains`: ["mannai.com.qa"] — used to distinguish colleague
  traffic if needed by rules.

### Workbook layout

**Inbox sheet** (one row per conversation, newest at bottom):
Sr. | Project Name | Sales Representative | Received Date (From Source) |
Task Required | Status | Remarks | Working Date | Subject | Sender |
ConversationKey (hidden column).

**Sent Items sheet** (one row per conversation initiated by the user or where
the user replied): Sr. | Project Name | To | Sent Date | Task Required |
Remarks | Subject | ConversationKey (hidden).

**Dashboard sheet** (formulas only, no macros): open vs closed counts, counts
by Task Required code, counts by Sales Representative, items this week /
this month, and a pending-items table (rows with empty Status) via
formulas over the Inbox sheet.

Column set intentionally matches the team sheet (Sr. → Working Date) so a
block of cells can be copy-pasted straight into the H. tab.

## Data flow

1. Script attaches to (or invisibly starts) classic Outlook via COM.
2. Reads Inbox + Sent Items restricted to items received/sent after
   `max(state.lastRun, config.sinceDate)`, using the store for the configured
   mailbox only.
3. Groups items by conversation (ConversationID; fallback to normalized
   subject if unavailable).
4. Applies rules → candidate rows. Conversations already present in the
   workbook (matched on hidden ConversationKey) are **updated in place** but
   only in cells that are still empty or previously auto-filled-and-unedited:
   in practice the script fills only empty cells (Status, Working Date,
   Remarks) and never overwrites non-empty cells. New conversations are
   appended.
5. Status logic: if any Sent item exists in the conversation → Status `C`,
   Working Date = date of the user's latest reply. Otherwise Status blank +
   yellow highlight (visible pending work).
6. Writes via Excel COM (Excel is installed); saves; prints run summary
   (added / updated / needs-review counts) and writes the log file.
7. Updates state.json (lastRun, conversation keys).

## Error handling

- Outlook not running → start it via COM (session is local; no prompts
  expected under same-profile automation).
- Workbook open in Excel → detect lock file / open failure, tell the user to
  close it, exit without changes.
- Any item that throws (weird item types: reports, receipts) → skipped and
  noted in the run log, never aborts the whole run.
- Script never deletes rows. Re-running is idempotent (keyed on
  ConversationKey).
- If the mailbox store is not found (profile changed) → clear error message.
- **Known risk:** Outlook's programmatic-access guard can show an "allow
  access" prompt (or block) when antivirus status is not detected as healthy.
  Mitigation: the script reads only dates/subjects/sender fields (lower-guard
  properties where possible); if the prompt appears the user allows access
  for 10 minutes per run. Documented in the run log if access is denied.

## Testing / validation

1. **Dry-run mode** (`-WhatIf` switch): prints planned rows to console and a
   CSV in `logs\`, touches nothing.
2. **Backfill validation:** run over May 1 – May 17, 2026 and compare against
   the user's 42 manual rows in the team sheet (ground truth) to tune
   `taskRules` and `salesReps` before going live.
3. Idempotency test: run twice; second run must add zero rows.
4. Edge cases covered in tests: meeting invites (different COM item class),
   conversations with no sent reply, unknown senders, ignored senders.

## Out of scope (YAGNI)

- Writing to the shared team log file.
- Scheduled/automatic daily runs (shortcut only; can add Task Scheduler later).
- AI classification of any kind.
- New Outlook (olk.exe) support — classic Outlook profile is present and used.
- Email body content analysis beyond subject + basic metadata (privacy +
  simplicity; revisit only if rules prove too weak during validation).

## Cost

Zero recurring cost. Build-time only Claude usage. No installs, no licenses,
no Power Automate dependency.
