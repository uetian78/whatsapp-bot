# Outlook Workflow Log Auto-Filler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fully local PowerShell tool that fills `Workflow Log.xlsx` (Inbox / Sent Items / Dashboard sheets) from classic Outlook via COM, with rule-based classification and yellow-highlight review cells.

**Architecture:** Pure logic (config, classification, conversation grouping) lives in `WorkflowLog.psm1` and is unit-tested with a zero-dependency test runner. Two thin COM adapters (Outlook reader, Excel writer) plus an orchestrator script `Update-WorkflowLog.ps1` are verified manually against the real mailbox and by an idempotency re-run.

**Tech Stack:** Windows PowerShell 5.1, Outlook COM (`Outlook.Application`), Excel COM (`Excel.Application`, Office 365 → `Formula2`/dynamic arrays allowed). No external modules, no internet, no AI.

**Spec:** `docs/superpowers/specs/2026-07-04-outlook-workflow-log-design.md` (WhatsAppBot repo)

## Global Constraints

- Tool directory (and its own git repo): `C:\Users\HP\OneDrive - MCL\WorkflowLog`
- Windows PowerShell 5.1 syntax only: no `&&`, no ternary, no `??`. Pipeline chaining via `;` / `if ($?)`.
- No installed dependencies of any kind (no Pester, no Python, no modules). Test runner is plain PowerShell.
- Mailbox: `Hassan.Saleem@mannai.com.qa` (classic Outlook profile "Outlook", store DisplayName equals the SMTP address).
- Email data never leaves the machine. No network calls anywhere in the tool.
- Backfill floor: `2026-05-01`. Overlap re-scan window: 7 days before last run.
- The script only appends rows and fills EMPTY cells; it never overwrites a non-empty cell and never deletes rows.
- Yellow highlight color: `65535`. Date format in cells: `dd-mmm-yyyy`.
- All file writes use `-Encoding utf8`.
- Commit after every task inside `C:\Users\HP\OneDrive - MCL\WorkflowLog` (NOT the WhatsAppBot repo). Never `git add -A` blindly; add named files.

### Shared data shapes (used by Tasks 4–7)

**MailItem record** (plain object produced by the Outlook adapter, consumed by `New-LogRows`):

```powershell
[pscustomobject]@{
    Folder          = 'Inbox'      # or 'Sent'
    Subject         = 'RE: Zubara Project Submittals RTCC'
    SenderEmail     = 'ajay@mannai.com.qa'   # lowercase SMTP
    SenderName      = 'Ajay Kumar'
    ToRecipients    = 'Dina; Ahmed Sherien'  # only meaningful for Sent
    Date            = [datetime]'2026-05-13 09:15'  # ReceivedTime or SentOn
    ConversationKey = 'ABC123…'    # Outlook ConversationID; never empty (fallback = normalized subject)
    IsMeeting       = $false       # MessageClass starts with 'IPM.Schedule.Meeting'
}
```

**RowSet** (produced by `New-LogRows`, consumed by the Excel writer):

```powershell
[pscustomobject]@{
    Inbox = @( [pscustomobject]@{
        ConversationKey; ProjectName; SalesRep; SalesRepReview; # bool
        ReceivedDate;                                           # datetime
        TaskRequired; TaskReview;                               # '' + $true when unmatched
        Status;                                                 # 'C' or ''
        WorkingDate;                                            # datetime or $null
        Subject; Sender } )
    Sent  = @( [pscustomobject]@{
        ConversationKey; ProjectName; To; SentDate; TaskRequired; Subject } )
}
```

---

### Task 1: Scaffold tool folder, config, test harness

**Files:**
- Create: `C:\Users\HP\OneDrive - MCL\WorkflowLog\.gitignore`
- Create: `C:\Users\HP\OneDrive - MCL\WorkflowLog\config.json`
- Create: `C:\Users\HP\OneDrive - MCL\WorkflowLog\WorkflowLog.psm1` (empty shell)
- Create: `C:\Users\HP\OneDrive - MCL\WorkflowLog\tests\Run-Tests.ps1`

**Interfaces:**
- Produces: test harness functions `Assert-Equal $Expected $Actual $Name` and `Assert-True $Cond $Name`; `config.json` schema consumed by all later tasks.

- [ ] **Step 1: Create folder and git repo**

```powershell
New-Item -ItemType Directory -Force "C:\Users\HP\OneDrive - MCL\WorkflowLog\tests"
New-Item -ItemType Directory -Force "C:\Users\HP\OneDrive - MCL\WorkflowLog\logs"
Set-Location "C:\Users\HP\OneDrive - MCL\WorkflowLog"
git init
```

- [ ] **Step 2: Write .gitignore**

```
Workflow Log.xlsx
state.json
logs/
~$*
```

- [ ] **Step 3: Write config.json**

```json
{
  "mailbox": "Hassan.Saleem@mannai.com.qa",
  "sinceDate": "2026-05-01",
  "rescanDays": 7,
  "salesReps": {},
  "taskRules": [
    { "code": "MS", "keywords": ["submittal", "material approval"] },
    { "code": "RTCC", "keywords": ["rtcc", "consultant comment", "reply to comment", "comments reply"] },
    { "code": "Meeting", "keywords": ["meeting", "minutes of meeting", "mom -"] },
    { "code": "Q", "keywords": ["quotation", "pricing", "selection", "offer", "boq", "quote", "price", "proposal"] }
  ],
  "ignoreSenders": ["no-reply", "noreply", "notification", "newsletter", "mailer-daemon", "postmaster"],
  "internalDomains": ["mannai.com.qa"]
}
```

(`salesReps` is seeded from the real mailbox in Task 6. Rule order matters: MS before RTCC — the team sheet's row "Zubara Project Submittals RTCC" was manually logged as MS.)

- [ ] **Step 4: Write the test harness** `tests\Run-Tests.ps1`

```powershell
# Zero-dependency test runner. Usage: powershell -NoProfile -File tests\Run-Tests.ps1
$ErrorActionPreference = 'Stop'
$script:Passed = 0; $script:Failed = 0

function Assert-Equal($Expected, $Actual, $Name) {
    if ("$Expected" -ceq "$Actual") { $script:Passed++; Write-Host "PASS  $Name" -ForegroundColor Green }
    else { $script:Failed++; Write-Host "FAIL  $Name`n      expected [$Expected]`n      actual   [$Actual]" -ForegroundColor Red }
}
function Assert-True($Cond, $Name) {
    if ($Cond) { $script:Passed++; Write-Host "PASS  $Name" -ForegroundColor Green }
    else { $script:Failed++; Write-Host "FAIL  $Name (condition was false)" -ForegroundColor Red }
}

Import-Module "$PSScriptRoot\..\WorkflowLog.psm1" -Force

# ---- tests (appended by later tasks) ----

# ---- summary ----
Write-Host "`nPassed: $script:Passed  Failed: $script:Failed"
if ($script:Failed -gt 0) { exit 1 } else { exit 0 }
```

- [ ] **Step 5: Create empty module shell** `WorkflowLog.psm1`

```powershell
# WorkflowLog.psm1 — pure logic for the Outlook workflow log auto-filler.
# No COM, no I/O side effects beyond reading/writing the JSON files passed in.

Export-ModuleMember -Function @()
```

- [ ] **Step 6: Run harness, expect clean pass with 0 tests**

Run: `powershell -NoProfile -File "C:\Users\HP\OneDrive - MCL\WorkflowLog\tests\Run-Tests.ps1"`
Expected: `Passed: 0  Failed: 0`, exit 0

- [ ] **Step 7: Commit**

```powershell
git add .gitignore config.json WorkflowLog.psm1 tests/Run-Tests.ps1
git commit -m "chore: scaffold WorkflowLog tool with config and test harness"
```

---

### Task 2: Config and state loading (`Get-WlConfig`, `Get-WlState`, `Save-WlState`)

**Files:**
- Modify: `C:\Users\HP\OneDrive - MCL\WorkflowLog\WorkflowLog.psm1`
- Modify: `C:\Users\HP\OneDrive - MCL\WorkflowLog\tests\Run-Tests.ps1`

**Interfaces:**
- Produces: `Get-WlConfig -Path <string>` → config object (throws on missing file/keys); `Get-WlState -Path <string>` → `@{ lastRun = [datetime]|$null }`; `Save-WlState -Path <string> -LastRun [datetime]`; `Get-WlScanStart -Config <cfg> -State <state>` → `[datetime]` (max of sinceDate vs lastRun−rescanDays).

- [ ] **Step 1: Add failing tests to Run-Tests.ps1** (in the `---- tests ----` section)

```powershell
# --- Task 2: config & state ---
$tmp = Join-Path $env:TEMP "wl-tests"
New-Item -ItemType Directory -Force $tmp | Out-Null

$goodCfg = '{"mailbox":"a@b.c","sinceDate":"2026-05-01","rescanDays":7,"salesReps":{},"taskRules":[],"ignoreSenders":[],"internalDomains":[]}'
Set-Content "$tmp\cfg.json" $goodCfg -Encoding utf8
$cfg = Get-WlConfig -Path "$tmp\cfg.json"
Assert-Equal 'a@b.c' $cfg.mailbox 'Get-WlConfig reads mailbox'

$badCfg = '{"mailbox":"a@b.c"}'
Set-Content "$tmp\bad.json" $badCfg -Encoding utf8
$threw = $false
try { Get-WlConfig -Path "$tmp\bad.json" | Out-Null } catch { $threw = $true }
Assert-True $threw 'Get-WlConfig throws on missing keys'

Remove-Item "$tmp\state.json" -ErrorAction SilentlyContinue
$state = Get-WlState -Path "$tmp\state.json"
Assert-Equal '' "$($state.lastRun)" 'Get-WlState default lastRun is null'

Save-WlState -Path "$tmp\state.json" -LastRun ([datetime]'2026-07-01 10:00')
$state2 = Get-WlState -Path "$tmp\state.json"
Assert-Equal ([datetime]'2026-07-01 10:00') $state2.lastRun 'state round-trips'

# scan start: no lastRun -> sinceDate
Assert-Equal ([datetime]'2026-05-01') (Get-WlScanStart -Config $cfg -State $state) 'scan start = sinceDate on first run'
# scan start: lastRun minus rescanDays, floored at sinceDate
Assert-Equal ([datetime]'2026-06-24 10:00') (Get-WlScanStart -Config $cfg -State $state2) 'scan start = lastRun - rescanDays'
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `powershell -NoProfile -File "C:\Users\HP\OneDrive - MCL\WorkflowLog\tests\Run-Tests.ps1"`
Expected: error `Get-WlConfig is not recognized` (harness dies with $ErrorActionPreference=Stop — that counts as failing)

- [ ] **Step 3: Implement in WorkflowLog.psm1**

```powershell
function Get-WlConfig {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path $Path)) { throw "Config not found: $Path" }
    $cfg = Get-Content $Path -Raw | ConvertFrom-Json
    foreach ($k in 'mailbox','sinceDate','rescanDays','salesReps','taskRules','ignoreSenders') {
        if ($null -eq $cfg.PSObject.Properties[$k]) { throw "config.json missing key: $k" }
    }
    return $cfg
}

function Get-WlState {
    param([Parameter(Mandatory)][string]$Path)
    if (Test-Path $Path) {
        $raw = Get-Content $Path -Raw | ConvertFrom-Json
        return [pscustomobject]@{ lastRun = [datetime]$raw.lastRun }
    }
    return [pscustomobject]@{ lastRun = $null }
}

function Save-WlState {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][datetime]$LastRun)
    [pscustomobject]@{ lastRun = $LastRun.ToString('o') } | ConvertTo-Json | Set-Content $Path -Encoding utf8
}

function Get-WlScanStart {
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)]$State)
    $floor = [datetime]$Config.sinceDate
    if ($null -eq $State.lastRun) { return $floor }
    $candidate = $State.lastRun.AddDays(-[int]$Config.rescanDays)
    if ($candidate -lt $floor) { return $floor }
    return $candidate
}

Export-ModuleMember -Function Get-WlConfig, Get-WlState, Save-WlState, Get-WlScanStart
```

- [ ] **Step 4: Run tests, verify pass**

Run: `powershell -NoProfile -File "C:\Users\HP\OneDrive - MCL\WorkflowLog\tests\Run-Tests.ps1"`
Expected: `Passed: 6  Failed: 0`

- [ ] **Step 5: Commit**

```powershell
git add WorkflowLog.psm1 tests/Run-Tests.ps1
git commit -m "feat: config and state loading with rescan-window scan start"
```

---

### Task 3: Subject cleaning and task classification (`ConvertTo-ProjectName`, `Get-TaskCode`)

**Files:**
- Modify: `C:\Users\HP\OneDrive - MCL\WorkflowLog\WorkflowLog.psm1`
- Modify: `C:\Users\HP\OneDrive - MCL\WorkflowLog\tests\Run-Tests.ps1`

**Interfaces:**
- Produces: `ConvertTo-ProjectName -Subject <string>` → cleaned string; `Get-TaskCode -Subject <string> -TaskRules <array> -IsMeeting <bool>` → `'Q'|'MS'|'RTCC'|'Meeting'|''` (first-match-wins over ordered rules; `IsMeeting` short-circuits to `'Meeting'`).

- [ ] **Step 1: Add failing tests**

```powershell
# --- Task 3: subject cleaning & task classification ---
Assert-Equal 'Zubara Project Submittals' (ConvertTo-ProjectName -Subject 'RE: RE: FW: Zubara Project Submittals') 'strips stacked RE/FW prefixes'
Assert-Equal 'MOI Extension Building' (ConvertTo-ProjectName -Subject '[EXTERNAL] MOI Extension Building') 'strips bracket tags'
Assert-Equal 'PS1 Project' (ConvertTo-ProjectName -Subject '  Fwd:  PS1 Project  ') 'strips Fwd and trims'

$rules = (Get-WlConfig -Path "C:\Users\HP\OneDrive - MCL\WorkflowLog\config.json").taskRules
Assert-Equal 'MS' (Get-TaskCode -Subject 'Zubara Project Submittals RTCC' -TaskRules $rules -IsMeeting $false) 'MS wins over RTCC (rule order)'
Assert-Equal 'RTCC' (Get-TaskCode -Subject 'Reply to comment - Physiotherapy Hospital' -TaskRules $rules -IsMeeting $false) 'RTCC keyword'
Assert-Equal 'Q' (Get-TaskCode -Subject 'CHW AC Units VVIP Palace - Selection and Pricing' -TaskRules $rules -IsMeeting $false) 'Q keyword'
Assert-Equal 'Meeting' (Get-TaskCode -Subject 'Anything at all' -TaskRules $rules -IsMeeting $true) 'meeting item short-circuits'
Assert-Equal '' (Get-TaskCode -Subject 'Hello there' -TaskRules $rules -IsMeeting $false) 'no match -> empty'
```

- [ ] **Step 2: Run tests, verify the new ones fail** (`ConvertTo-ProjectName is not recognized`)

- [ ] **Step 3: Implement**

```powershell
function ConvertTo-ProjectName {
    param([Parameter(Mandatory)][string]$Subject)
    $s = $Subject.Trim()
    $changed = $true
    while ($changed) {
        $before = $s
        $s = $s -replace '^(?i)\s*(re|fw|fwd)\s*:\s*', ''
        $s = $s -replace '^\s*\[[^\]]*\]\s*', ''
        $changed = ($s -ne $before)
    }
    return $s.Trim()
}

function Get-TaskCode {
    param(
        [Parameter(Mandatory)][string]$Subject,
        [Parameter(Mandatory)][AllowEmptyCollection()]$TaskRules,
        [bool]$IsMeeting = $false
    )
    if ($IsMeeting) { return 'Meeting' }
    foreach ($rule in $TaskRules) {
        foreach ($kw in $rule.keywords) {
            if ($Subject -match [regex]::Escape($kw)) { return $rule.code }  # -match is case-insensitive
        }
    }
    return ''
}
```

Add both names to `Export-ModuleMember`.

- [ ] **Step 4: Run tests, verify pass** — Expected: `Passed: 14  Failed: 0`

- [ ] **Step 5: Commit** — `git add WorkflowLog.psm1 tests/Run-Tests.ps1; git commit -m "feat: subject cleaning and ordered keyword task classification"`

---

### Task 4: Sales rep resolution and sender filtering (`Resolve-SalesRep`, `Test-IgnoredSender`)

**Files:**
- Modify: `C:\Users\HP\OneDrive - MCL\WorkflowLog\WorkflowLog.psm1`
- Modify: `C:\Users\HP\OneDrive - MCL\WorkflowLog\tests\Run-Tests.ps1`

**Interfaces:**
- Produces: `Resolve-SalesRep -SenderEmail <string> -SenderName <string> -SalesReps <obj>` → `@{ Name; NeedsReview[bool] }`; `Test-IgnoredSender -SenderEmail <string> -IgnoreSenders <string[]>` → bool.

- [ ] **Step 1: Add failing tests**

```powershell
# --- Task 4: sales rep & ignore ---
$reps = '{"ajay@mannai.com.qa":"Ajay","dina@mannai.com.qa":"Dina"}' | ConvertFrom-Json
$r = Resolve-SalesRep -SenderEmail 'AJAY@Mannai.com.qa' -SenderName 'Ajay Kumar' -SalesReps $reps
Assert-Equal 'Ajay' $r.Name 'known rep resolved case-insensitively'
Assert-True (-not $r.NeedsReview) 'known rep needs no review'
$u = Resolve-SalesRep -SenderEmail 'new@vendor.com' -SenderName 'New Vendor' -SalesReps $reps
Assert-Equal 'New Vendor' $u.Name 'unknown falls back to display name'
Assert-True $u.NeedsReview 'unknown flagged for review'
Assert-True (Test-IgnoredSender -SenderEmail 'no-reply@teams.microsoft.com' -IgnoreSenders @('no-reply','newsletter')) 'ignores no-reply'
Assert-True (-not (Test-IgnoredSender -SenderEmail 'ajay@mannai.com.qa' -IgnoreSenders @('no-reply'))) 'keeps normal sender'
```

- [ ] **Step 2: Run tests, verify the new ones fail**

- [ ] **Step 3: Implement**

```powershell
function Resolve-SalesRep {
    param([string]$SenderEmail = '', [string]$SenderName = '', [Parameter(Mandatory)]$SalesReps)
    foreach ($p in $SalesReps.PSObject.Properties) {
        if ($p.Name -ieq $SenderEmail) {
            return [pscustomobject]@{ Name = $p.Value; NeedsReview = $false }
        }
    }
    return [pscustomobject]@{ Name = $SenderName; NeedsReview = $true }
}

function Test-IgnoredSender {
    param([string]$SenderEmail = '', [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$IgnoreSenders)
    foreach ($pat in $IgnoreSenders) {
        if ($SenderEmail -like "*$pat*") { return $true }
    }
    return $false
}
```

Add both to `Export-ModuleMember`.

- [ ] **Step 4: Run tests, verify pass** — Expected: `Passed: 20  Failed: 0`

- [ ] **Step 5: Commit** — `git add WorkflowLog.psm1 tests/Run-Tests.ps1; git commit -m "feat: sales rep lookup with review flag and sender ignore filter"`

---

### Task 5: Conversation grouping and row building (`New-LogRows`)

**Files:**
- Modify: `C:\Users\HP\OneDrive - MCL\WorkflowLog\WorkflowLog.psm1`
- Modify: `C:\Users\HP\OneDrive - MCL\WorkflowLog\tests\Run-Tests.ps1`

**Interfaces:**
- Consumes: MailItem records (shape in Global Constraints), `Resolve-SalesRep`, `Get-TaskCode`, `ConvertTo-ProjectName`, `Test-IgnoredSender`.
- Produces: `New-LogRows -Items <MailItem[]> -Config <cfg>` → RowSet (shape in Global Constraints). Ignored senders' inbox items are dropped before grouping. One Inbox row per conversation that has ≥1 inbox item (earliest inbox item defines Project/Rep/Date/Task); Status `C` + WorkingDate = latest sent date when a sent item exists in the conversation. One Sent row per conversation that has ≥1 sent item (earliest sent item).

- [ ] **Step 1: Add failing tests**

```powershell
# --- Task 5: grouping & row building ---
function New-TestItem($folder, $subject, $email, $name, $date, $conv, $meeting=$false, $to='') {
    [pscustomobject]@{ Folder=$folder; Subject=$subject; SenderEmail=$email; SenderName=$name;
        ToRecipients=$to; Date=[datetime]$date; ConversationKey=$conv; IsMeeting=$meeting }
}
$cfgFull = Get-WlConfig -Path "C:\Users\HP\OneDrive - MCL\WorkflowLog\config.json"
$items = @(
    New-TestItem 'Inbox' 'Zubara Fans Selections' 'hm@mannai.com.qa' 'Hassan Mustafa' '2026-05-13 08:00' 'CONV1'
    New-TestItem 'Inbox' 'RE: Zubara Fans Selections' 'hm@mannai.com.qa' 'Hassan Mustafa' '2026-05-14 09:00' 'CONV1'
    New-TestItem 'Sent'  'RE: Zubara Fans Selections' 'me@mannai.com.qa' 'Me' '2026-05-17 10:00' 'CONV1' $false 'Hassan Mustafa'
    New-TestItem 'Inbox' 'PS1 Project queries' 'someone@external-vendor.com' 'Ext Vendor' '2026-05-13 11:00' 'CONV2'
    New-TestItem 'Inbox' 'Weekly digest' 'no-reply@x.com' 'Bot' '2026-05-13 12:00' 'CONV3'
    New-TestItem 'Sent'  'New quotation for MOEHE' 'me@mannai.com.qa' 'Me' '2026-05-15 15:00' 'CONV4' $false 'Dina'
)
$rows = New-LogRows -Items $items -Config $cfgFull
Assert-Equal 2 $rows.Inbox.Count 'two inbox conversations (ignored sender dropped)'
$c1 = $rows.Inbox | Where-Object ConversationKey -eq 'CONV1'
Assert-Equal 'Zubara Fans Selections' $c1.ProjectName 'project from earliest inbox item'
Assert-Equal 'C' $c1.Status 'replied conversation is closed'
Assert-Equal ([datetime]'2026-05-17 10:00') $c1.WorkingDate 'working date = latest reply'
Assert-Equal 'Q' $c1.TaskRequired 'selection keyword -> Q'
$c2 = $rows.Inbox | Where-Object ConversationKey -eq 'CONV2'
Assert-Equal '' $c2.Status 'unreplied conversation stays open'
Assert-True $c2.SalesRepReview 'unknown external sender flagged for review'
Assert-Equal 2 $rows.Sent.Count 'sent rows: replied conv + sent-only conv'
$c4 = $rows.Sent | Where-Object ConversationKey -eq 'CONV4'
Assert-Equal 'Q' $c4.TaskRequired 'sent-only quotation classified Q'
Assert-Equal 'Dina' $c4.To 'recipients captured'
```

- [ ] **Step 2: Run tests, verify the new ones fail**

- [ ] **Step 3: Implement**

```powershell
function New-LogRows {
    param([Parameter(Mandatory)][AllowEmptyCollection()]$Items, [Parameter(Mandatory)]$Config)
    $kept = @($Items | Where-Object {
        $_.Folder -eq 'Sent' -or -not (Test-IgnoredSender -SenderEmail $_.SenderEmail -IgnoreSenders $Config.ignoreSenders)
    })
    $inboxRows = New-Object System.Collections.Generic.List[object]
    $sentRows  = New-Object System.Collections.Generic.List[object]
    foreach ($g in ($kept | Group-Object ConversationKey)) {
        $inbox = @($g.Group | Where-Object Folder -eq 'Inbox' | Sort-Object Date)
        $sent  = @($g.Group | Where-Object Folder -eq 'Sent'  | Sort-Object Date)
        if ($inbox.Count -gt 0) {
            $first = $inbox[0]
            $rep  = Resolve-SalesRep -SenderEmail $first.SenderEmail -SenderName $first.SenderName -SalesReps $Config.salesReps
            $task = Get-TaskCode -Subject $first.Subject -TaskRules $Config.taskRules -IsMeeting $first.IsMeeting
            $lastReply = $null
            if ($sent.Count -gt 0) { $lastReply = $sent[-1].Date }
            $status = ''
            if ($null -ne $lastReply) { $status = 'C' }
            $inboxRows.Add([pscustomobject]@{
                ConversationKey = $g.Name
                ProjectName     = ConvertTo-ProjectName -Subject $first.Subject
                SalesRep        = $rep.Name
                SalesRepReview  = $rep.NeedsReview
                ReceivedDate    = $first.Date
                TaskRequired    = $task
                TaskReview      = ($task -eq '')
                Status          = $status
                WorkingDate     = $lastReply
                Subject         = $first.Subject
                Sender          = $first.SenderName
            })
        }
        if ($sent.Count -gt 0) {
            $fs = $sent[0]
            $sentRows.Add([pscustomobject]@{
                ConversationKey = $g.Name
                ProjectName     = ConvertTo-ProjectName -Subject $fs.Subject
                To              = $fs.ToRecipients
                SentDate        = $fs.Date
                TaskRequired    = Get-TaskCode -Subject $fs.Subject -TaskRules $Config.taskRules -IsMeeting $fs.IsMeeting
                Subject         = $fs.Subject
            })
        }
    }
    return [pscustomobject]@{ Inbox = $inboxRows.ToArray(); Sent = $sentRows.ToArray() }
}
```

Add to `Export-ModuleMember`.

- [ ] **Step 4: Run tests, verify pass** — Expected: `Passed: 30  Failed: 0`

- [ ] **Step 5: Commit** — `git add WorkflowLog.psm1 tests/Run-Tests.ps1; git commit -m "feat: conversation grouping with status/working-date derivation"`

---

### Task 6: Outlook COM adapter (`OutlookAdapter.ps1`) + salesReps seeding

**Files:**
- Create: `C:\Users\HP\OneDrive - MCL\WorkflowLog\OutlookAdapter.ps1` (dot-sourced by the orchestrator)
- Modify: `C:\Users\HP\OneDrive - MCL\WorkflowLog\config.json` (seed salesReps from real senders)

**Interfaces:**
- Produces: `Read-OutlookItems -Since <datetime> -Config <cfg>` → MailItem[] (shape in Global Constraints); `Get-SenderStats -Since <datetime> -Config <cfg>` → objects `@{ Email; Name; Count }` sorted desc.
- COM adapter has NO unit tests; verified manually against the live mailbox (read-only operations).

- [ ] **Step 1: Write OutlookAdapter.ps1**

```powershell
# OutlookAdapter.ps1 — thin COM wrapper. Read-only against the mailbox.
$ErrorActionPreference = 'Stop'

function Get-WlOutlookStore {
    param([Parameter(Mandatory)]$Config)
    $ol = New-Object -ComObject Outlook.Application
    $ns = $ol.GetNamespace('MAPI')
    foreach ($store in $ns.Stores) {
        if ($store.DisplayName -ieq $Config.mailbox) { return $store }
    }
    $names = @(); foreach ($s in $ns.Stores) { $names += $s.DisplayName }
    throw "Mailbox store '$($Config.mailbox)' not found. Available stores: $($names -join ', ')"
}

function Get-WlSmtpAddress {
    param($Item)
    try {
        if ($Item.SenderEmailType -eq 'EX') {
            $ex = $Item.Sender.GetExchangeUser()
            if ($ex -and $ex.PrimarySmtpAddress) { return $ex.PrimarySmtpAddress.ToLower() }
        }
        if ($Item.SenderEmailAddress) { return $Item.SenderEmailAddress.ToLower() }
    } catch { }
    return ''
}

function Read-WlFolder {
    param($Folder, [string]$FolderTag, [string]$DateProp, [datetime]$Since)
    $filter = "[$DateProp] >= '" + $Since.ToString('MM/dd/yyyy HH:mm') + "'"
    $items = $Folder.Items.Restrict($filter)
    $items.Sort("[$DateProp]")
    $result = New-Object System.Collections.Generic.List[object]
    foreach ($item in $items) {
        try {
            $class = $item.MessageClass
            if ($class -notlike 'IPM.Note*' -and $class -notlike 'IPM.Schedule.Meeting*') { continue }
            $conv = ''
            try { $conv = $item.ConversationID } catch { }
            if ([string]::IsNullOrEmpty($conv)) {
                $conv = 'SUBJ:' + ($item.Subject -replace '(?i)^\s*(re|fw|fwd)\s*:\s*','').Trim().ToLower()
            }
            $date = $item.PSObject.Properties[$DateProp].Value
            $result.Add([pscustomobject]@{
                Folder          = $FolderTag
                Subject         = [string]$item.Subject
                SenderEmail     = (Get-WlSmtpAddress -Item $item)
                SenderName      = [string]$item.SenderName
                ToRecipients    = [string]$item.To
                Date            = [datetime]$date
                ConversationKey = $conv
                IsMeeting       = ($class -like 'IPM.Schedule.Meeting*')
            })
        } catch {
            Write-Warning "Skipped one item in ${FolderTag}: $($_.Exception.Message)"
        }
    }
    return $result.ToArray()
}

function Read-OutlookItems {
    param([Parameter(Mandatory)][datetime]$Since, [Parameter(Mandatory)]$Config)
    $store = Get-WlOutlookStore -Config $Config
    $inbox = Read-WlFolder -Folder $store.GetDefaultFolder(6) -FolderTag 'Inbox' -DateProp 'ReceivedTime' -Since $Since
    $sent  = Read-WlFolder -Folder $store.GetDefaultFolder(5) -FolderTag 'Sent'  -DateProp 'SentOn'       -Since $Since
    return @($inbox) + @($sent)
}

function Get-SenderStats {
    param([Parameter(Mandatory)][datetime]$Since, [Parameter(Mandatory)]$Config)
    $items = Read-OutlookItems -Since $Since -Config $Config
    $items | Where-Object { $_.Folder -eq 'Inbox' -and $_.SenderEmail } |
        Group-Object SenderEmail |
        ForEach-Object { [pscustomobject]@{ Email = $_.Name; Name = $_.Group[0].SenderName; Count = $_.Count } } |
        Sort-Object Count -Descending
}
```

- [ ] **Step 2: Manual verification — read counts from the live mailbox**

Run:

```powershell
Set-Location "C:\Users\HP\OneDrive - MCL\WorkflowLog"
Import-Module .\WorkflowLog.psm1 -Force; . .\OutlookAdapter.ps1
$cfg = Get-WlConfig -Path .\config.json
$items = Read-OutlookItems -Since ([datetime]'2026-05-01') -Config $cfg
"Total: $($items.Count)  Inbox: $(@($items | Where-Object Folder -eq 'Inbox').Count)  Sent: $(@($items | Where-Object Folder -eq 'Sent').Count)"
$items | Select-Object -First 5 Folder, Date, SenderName, Subject | Format-Table
```

Expected: non-zero counts, plausible recent subjects, no unhandled exception. If Outlook's programmatic-access prompt appears, choose Allow (10 minutes). If counts are zero, check the store DisplayName in the error message.

- [ ] **Step 3: Seed salesReps in config.json**

Run:

```powershell
Get-SenderStats -Since ([datetime]'2026-05-01') -Config $cfg | Select-Object -First 30 | Format-Table
```

From the output, add the real colleagues to `config.json` → `salesReps` (email → short name as used in the team sheet: Ajay, Dina, Zahran, Ahmed Sherien, Hassan Mustafa, Eckrima, Rawan Sobh, Hussein, …). Skip vendors/automated senders. Present the mapping to the user for confirmation before committing.

- [ ] **Step 4: Re-run full test suite (must still pass)** — `powershell -NoProfile -File tests\Run-Tests.ps1` → `Failed: 0`

- [ ] **Step 5: Commit** — `git add OutlookAdapter.ps1 config.json; git commit -m "feat: Outlook COM adapter with conversation keys and sender seeding"`

---

### Task 7: Excel COM adapter (`ExcelAdapter.ps1`) — template + row writer

**Files:**
- Create: `C:\Users\HP\OneDrive - MCL\WorkflowLog\ExcelAdapter.ps1`

**Interfaces:**
- Consumes: RowSet from `New-LogRows`.
- Produces: `Update-WlWorkbook -Path <string> -RowSet <RowSet>` → summary `@{ AddedInbox; AddedSent; UpdatedInbox; NeedsReview }`. Creates the workbook from scratch when missing (Inbox, Sent Items, Dashboard sheets). Appends new conversations; for existing ConversationKeys fills ONLY empty Status/Working Date cells; never touches non-empty cells.

**Workbook layout (both data sheets have header in row 1, data from row 2):**

- Inbox columns: A `Sr.` | B `Project Name` | C `Sales Representative` | D `Received Date (From Source)` | E `Task Required` | F `Status` | G `Remarks` | H `Working Date` | I `Subject` | J `Sender` | K `ConversationKey` (hidden)
- Sent Items columns: A `Sr.` | B `Project Name` | C `To` | D `Sent Date` | E `Task Required` | F `Remarks` | G `Subject` | H `ConversationKey` (hidden)

- [ ] **Step 1: Write ExcelAdapter.ps1**

```powershell
# ExcelAdapter.ps1 — Excel COM writer. Append-only + fill-empty-cells policy.
$ErrorActionPreference = 'Stop'
$script:WlYellow = 65535

function New-WlWorkbook {
    param($Excel, [string]$Path)
    $wb = $Excel.Workbooks.Add()
    while ($wb.Worksheets.Count -gt 1) { $wb.Worksheets.Item(2).Delete() }
    $inbox = $wb.Worksheets.Item(1); $inbox.Name = 'Inbox'
    $headers = @('Sr.','Project Name','Sales Representative','Received Date (From Source)','Task Required','Status','Remarks','Working Date','Subject','Sender','ConversationKey')
    for ($i = 0; $i -lt $headers.Count; $i++) { $inbox.Cells.Item(1, $i + 1).Value2 = $headers[$i] }
    $inbox.Range('A1:K1').Font.Bold = $true
    $inbox.Columns.Item(11).Hidden = $true

    $sent = $wb.Worksheets.Add([System.Reflection.Missing]::Value, $inbox); $sent.Name = 'Sent Items'
    $sHeaders = @('Sr.','Project Name','To','Sent Date','Task Required','Remarks','Subject','ConversationKey')
    for ($i = 0; $i -lt $sHeaders.Count; $i++) { $sent.Cells.Item(1, $i + 1).Value2 = $sHeaders[$i] }
    $sent.Range('A1:H1').Font.Bold = $true
    $sent.Columns.Item(8).Hidden = $true

    $dash = $wb.Worksheets.Add([System.Reflection.Missing]::Value, $sent); $dash.Name = 'Dashboard'
    $dash.Cells.Item(1,1).Value2 = 'Workflow Tracker Dashboard'; $dash.Cells.Item(1,1).Font.Size = 16; $dash.Cells.Item(1,1).Font.Bold = $true
    $dash.Cells.Item(3,1).Value2 = 'Total logged';        $dash.Cells.Item(3,2).Formula = '=COUNTA(Inbox!K:K)-1'
    $dash.Cells.Item(4,1).Value2 = 'Closed (C)';          $dash.Cells.Item(4,2).Formula = '=COUNTIF(Inbox!F:F,"C")'
    $dash.Cells.Item(5,1).Value2 = 'Open / pending';      $dash.Cells.Item(5,2).Formula = '=B3-B4'
    $dash.Cells.Item(6,1).Value2 = 'Received this week';  $dash.Cells.Item(6,2).Formula = '=COUNTIFS(Inbox!D:D,">="&(TODAY()-WEEKDAY(TODAY(),3)),Inbox!D:D,"<"&(TODAY()+1))'
    $dash.Cells.Item(7,1).Value2 = 'Received this month'; $dash.Cells.Item(7,2).Formula = '=COUNTIFS(Inbox!D:D,">="&(EOMONTH(TODAY(),-1)+1))'
    $dash.Cells.Item(9,1).Value2 = 'By Task Required'; $dash.Cells.Item(9,1).Font.Bold = $true
    $row = 10
    foreach ($code in 'Q','MS','RTCC','Meeting') {
        $dash.Cells.Item($row,1).Value2 = $code
        $dash.Cells.Item($row,2).Formula = "=COUNTIF(Inbox!E:E,A$row)"
        $row++
    }
    $dash.Cells.Item(9,4).Value2 = 'By Sales Representative'; $dash.Cells.Item(9,4).Font.Bold = $true
    $dash.Cells.Item(10,4).Formula2 = '=IFERROR(SORT(UNIQUE(FILTER(Inbox!C2:C5000,Inbox!C2:C5000<>""))),"")'
    $dash.Cells.Item(10,5).Formula2 = '=IF(D10#="","",COUNTIF(Inbox!C:C,D10#))'
    $dash.Cells.Item(16,1).Value2 = 'Pending items (no reply yet)'; $dash.Cells.Item(16,1).Font.Bold = $true
    $dash.Cells.Item(17,1).Formula2 = '=IFERROR(FILTER(Inbox!B2:E5000,(Inbox!F2:F5000="")*(Inbox!K2:K5000<>"")),"none")'

    $wb.SaveAs($Path, 51)  # 51 = xlOpenXMLWorkbook (.xlsx)
    return $wb
}

function Get-WlKeyMap {
    param($Sheet, [int]$KeyCol)
    $map = @{}
    $last = $Sheet.Cells.Item($Sheet.Rows.Count, $KeyCol).End(-4162).Row  # -4162 = xlUp
    for ($r = 2; $r -le $last; $r++) {
        $k = [string]$Sheet.Cells.Item($r, $KeyCol).Value2
        if ($k) { $map[$k] = $r }
    }
    return $map
}

function Set-WlCell {
    param($Sheet, [int]$Row, [int]$Col, $Value, [bool]$Highlight = $false, [string]$NumberFormat = '')
    $cell = $Sheet.Cells.Item($Row, $Col)
    if ($NumberFormat) { $cell.NumberFormat = $NumberFormat }
    $cell.Value2 = $Value
    if ($Highlight) { $cell.Interior.Color = $script:WlYellow }
}

function Update-WlWorkbook {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$RowSet)
    $lockFile = Join-Path (Split-Path $Path) ('~$' + (Split-Path $Path -Leaf))
    if (Test-Path $lockFile) { throw "Workbook appears to be open in Excel. Close it and run again." }
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false; $excel.DisplayAlerts = $false
    $summary = [pscustomobject]@{ AddedInbox = 0; AddedSent = 0; UpdatedInbox = 0; NeedsReview = 0 }
    try {
        if (Test-Path $Path) { $wb = $excel.Workbooks.Open($Path) } else { $wb = New-WlWorkbook -Excel $excel -Path $Path }
        $inboxWs = $wb.Worksheets.Item('Inbox')
        $sentWs  = $wb.Worksheets.Item('Sent Items')
        $dateFmt = 'dd-mmm-yyyy'

        $inboxMap = Get-WlKeyMap -Sheet $inboxWs -KeyCol 11
        $nextRow = 2 + $inboxMap.Count
        foreach ($row in $RowSet.Inbox) {
            if ($inboxMap.ContainsKey($row.ConversationKey)) {
                # existing: fill ONLY empty Status (F) / Working Date (H)
                $r = $inboxMap[$row.ConversationKey]
                $curStatus = [string]$inboxWs.Cells.Item($r, 6).Value2
                if (-not $curStatus -and $row.Status -eq 'C') {
                    Set-WlCell $inboxWs $r 6 'C'
                    $inboxWs.Cells.Item($r, 6).Interior.ColorIndex = 0  # clear old highlight
                    if ($null -ne $row.WorkingDate -and -not $inboxWs.Cells.Item($r, 8).Value2) {
                        Set-WlCell $inboxWs $r 8 $row.WorkingDate.ToOADate() -NumberFormat $dateFmt
                    }
                    $summary.UpdatedInbox++
                }
                continue
            }
            Set-WlCell $inboxWs $nextRow 1  ($nextRow - 1)
            Set-WlCell $inboxWs $nextRow 2  $row.ProjectName $true          # project always reviewed
            Set-WlCell $inboxWs $nextRow 3  $row.SalesRep $row.SalesRepReview
            Set-WlCell $inboxWs $nextRow 4  $row.ReceivedDate.ToOADate() -NumberFormat $dateFmt
            Set-WlCell $inboxWs $nextRow 5  $row.TaskRequired $row.TaskReview
            Set-WlCell $inboxWs $nextRow 6  $row.Status ($row.Status -eq '')
            if ($null -ne $row.WorkingDate) { Set-WlCell $inboxWs $nextRow 8 $row.WorkingDate.ToOADate() -NumberFormat $dateFmt }
            Set-WlCell $inboxWs $nextRow 9  $row.Subject
            Set-WlCell $inboxWs $nextRow 10 $row.Sender
            Set-WlCell $inboxWs $nextRow 11 $row.ConversationKey
            if ($row.SalesRepReview -or $row.TaskReview -or $row.Status -eq '') { $summary.NeedsReview++ }
            $inboxMap[$row.ConversationKey] = $nextRow
            $nextRow++; $summary.AddedInbox++
        }

        $sentMap = Get-WlKeyMap -Sheet $sentWs -KeyCol 8
        $nextRow = 2 + $sentMap.Count
        foreach ($row in $RowSet.Sent) {
            if ($sentMap.ContainsKey($row.ConversationKey)) { continue }
            Set-WlCell $sentWs $nextRow 1 ($nextRow - 1)
            Set-WlCell $sentWs $nextRow 2 $row.ProjectName
            Set-WlCell $sentWs $nextRow 3 $row.To
            Set-WlCell $sentWs $nextRow 4 $row.SentDate.ToOADate() -NumberFormat $dateFmt
            Set-WlCell $sentWs $nextRow 5 $row.TaskRequired
            Set-WlCell $sentWs $nextRow 7 $row.Subject
            Set-WlCell $sentWs $nextRow 8 $row.ConversationKey
            $sentMap[$row.ConversationKey] = $nextRow
            $nextRow++; $summary.AddedSent++
        }

        $inboxWs.Columns.Item('A:J').AutoFit() | Out-Null
        $sentWs.Columns.Item('A:G').AutoFit() | Out-Null
        $wb.Save()
    }
    finally {
        if ($wb) { $wb.Close($false) }
        $excel.Quit()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
    }
    return $summary
}
```

- [ ] **Step 2: Manual verification — synthetic RowSet round-trip**

Run:

```powershell
Set-Location "C:\Users\HP\OneDrive - MCL\WorkflowLog"
Import-Module .\WorkflowLog.psm1 -Force; . .\ExcelAdapter.ps1
$rs = [pscustomobject]@{
    Inbox = @([pscustomobject]@{ ConversationKey='T1'; ProjectName='Test Project'; SalesRep='Ajay'; SalesRepReview=$false;
        ReceivedDate=[datetime]'2026-05-02'; TaskRequired='Q'; TaskReview=$false; Status=''; WorkingDate=$null;
        Subject='Test Project - selection'; Sender='Ajay' })
    Sent = @()
}
$s1 = Update-WlWorkbook -Path "$PWD\test-out.xlsx" -RowSet $rs
"Run1: added=$($s1.AddedInbox)"          # expect 1
$s2 = Update-WlWorkbook -Path "$PWD\test-out.xlsx" -RowSet $rs
"Run2: added=$($s2.AddedInbox)"          # expect 0 (idempotent)
$rs.Inbox[0].Status = 'C'; $rs.Inbox[0].WorkingDate = [datetime]'2026-05-05'
$s3 = Update-WlWorkbook -Path "$PWD\test-out.xlsx" -RowSet $rs
"Run3: updated=$($s3.UpdatedInbox)"      # expect 1 (status filled in place)
Remove-Item "$PWD\test-out.xlsx"
```

Expected: `added=1`, `added=0`, `updated=1`, no exceptions. Open the file once before deleting to eyeball the Dashboard formulas if desired.

- [ ] **Step 3: Commit** — `git add ExcelAdapter.ps1; git commit -m "feat: Excel writer with template, dashboard formulas, idempotent upsert"`

---

### Task 8: Orchestrator (`Update-WorkflowLog.ps1`) with dry-run, logging, backfill validation

**Files:**
- Create: `C:\Users\HP\OneDrive - MCL\WorkflowLog\Update-WorkflowLog.ps1`
- Modify (if validation demands): `C:\Users\HP\OneDrive - MCL\WorkflowLog\config.json` (tune taskRules/salesReps)

**Interfaces:**
- Consumes: everything above.
- Produces: the end-user entry point. `-WhatIf` switch = dry run (CSV to `logs\`, workbook untouched).

- [ ] **Step 1: Write Update-WorkflowLog.ps1**

```powershell
# Update-WorkflowLog.ps1 — reads Outlook, updates Workflow Log.xlsx. Fully local.
[CmdletBinding()]
param([switch]$WhatIf)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Import-Module "$root\WorkflowLog.psm1" -Force
. "$root\OutlookAdapter.ps1"
. "$root\ExcelAdapter.ps1"

$logFile = Join-Path $root ("logs\run-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
New-Item -ItemType Directory -Force (Join-Path $root 'logs') | Out-Null
Start-Transcript -Path $logFile | Out-Null
try {
    $cfg   = Get-WlConfig -Path "$root\config.json"
    $state = Get-WlState  -Path "$root\state.json"
    $since = Get-WlScanStart -Config $cfg -State $state
    Write-Host "Scanning mailbox '$($cfg.mailbox)' since $since ..."

    $runStart = Get-Date
    $items  = Read-OutlookItems -Since $since -Config $cfg
    Write-Host "Read $($items.Count) items."
    $rowSet = New-LogRows -Items $items -Config $cfg
    Write-Host "Conversations: inbox=$($rowSet.Inbox.Count) sent=$($rowSet.Sent.Count)"

    if ($WhatIf) {
        $csv = Join-Path $root ("logs\dryrun-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".csv")
        $rowSet.Inbox | Export-Csv $csv -NoTypeInformation -Encoding UTF8
        Write-Host "DRY RUN — no workbook changes. Planned inbox rows written to $csv"
        return
    }

    $summary = Update-WlWorkbook -Path "$root\Workflow Log.xlsx" -RowSet $rowSet
    Save-WlState -Path "$root\state.json" -LastRun $runStart
    Write-Host ""
    Write-Host ("DONE — Inbox: +{0} new, {1} closed out | Sent: +{2} new | {3} cells need your review (yellow)" -f `
        $summary.AddedInbox, $summary.UpdatedInbox, $summary.AddedSent, $summary.NeedsReview) -ForegroundColor Cyan
}
catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    Stop-Transcript | Out-Null
    if (-not $env:WL_NO_PAUSE) { Read-Host "Press Enter to close" | Out-Null }
}
```

(`Read-Host` at the end keeps the console open when launched from the desktop shortcut; set `WL_NO_PAUSE=1` when running from automation/Claude.)

- [ ] **Step 2: Dry run against the live mailbox**

Run: `$env:WL_NO_PAUSE='1'; powershell -NoProfile -File "C:\Users\HP\OneDrive - MCL\WorkflowLog\Update-WorkflowLog.ps1" -WhatIf`
Expected: item/conversation counts printed, CSV in `logs\`, no xlsx created.

- [ ] **Step 3: Backfill validation against the team sheet ground truth**

Open the dry-run CSV and compare May 1–17 rows against the user's 42 manual entries in `Technica team log sheet.xlsx` (H. sheet — read a scratchpad copy with openpyxl, never the original). Check: Task Required codes match ≥ 70% of comparable rows; sales reps resolve for the frequent colleagues; obvious noise (newsletters) absent. Tune `config.json` `taskRules` keywords / `salesReps` / `ignoreSenders` and re-run the dry run until satisfied. Record the final match rate in the commit message.

- [ ] **Step 4: First real run + idempotency check**

Run (without `-WhatIf`): expected `Workflow Log.xlsx` created, summary printed.
Run again immediately: expected `Inbox: +0 new`.
Open the workbook: Dashboard shows non-zero counts; pending items listed; yellow highlights on review cells.

- [ ] **Step 5: Full test suite still green** — `powershell -NoProfile -File tests\Run-Tests.ps1` → `Failed: 0`

- [ ] **Step 6: Commit** — `git add Update-WorkflowLog.ps1 config.json; git commit -m "feat: orchestrator with dry-run, logging; rules tuned to NN% vs manual log"`

---

### Task 9: Desktop shortcut + README

**Files:**
- Create: `C:\Users\HP\Desktop\Update Workflow Log.lnk`
- Create: `C:\Users\HP\OneDrive - MCL\WorkflowLog\README.md`

**Interfaces:** none (final polish).

- [ ] **Step 1: Create the shortcut**

```powershell
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut("$env:USERPROFILE\Desktop\Update Workflow Log.lnk")
$lnk.TargetPath = 'powershell.exe'
$lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\HP\OneDrive - MCL\WorkflowLog\Update-WorkflowLog.ps1"'
$lnk.WorkingDirectory = 'C:\Users\HP\OneDrive - MCL\WorkflowLog'
$lnk.IconLocation = 'C:\Program Files (x86)\Microsoft Office\Root\Office16\OUTLOOK.EXE,0'
$lnk.Save()
```

- [ ] **Step 2: Verify the shortcut** — double-click it (or `Start-Process` the .lnk); console opens, summary prints, waits for Enter.

- [ ] **Step 3: Write README.md** covering: what it does (1 paragraph), how to run (shortcut), what yellow cells mean, how to edit `config.json` (add a sales rep, add a task keyword, ignore a sender), where logs live, "safe to re-run any time", and the one-liner for copying rows into the team sheet (columns A–H align with the team sheet's Sr.→Working Date block).

- [ ] **Step 4: Final commit** — `git add README.md; git commit -m "docs: README and desktop shortcut"`

---

## Self-Review Notes

- Spec coverage: local COM approach (T6/T7), own workbook only (T7 path is the tool's own xlsx), rules+highlight (T3–T5, highlights in T7), status/working-date logic (T5), dashboard (T7), dry-run + May backfill validation vs ground truth (T8), idempotency (T7 step 2, T8 step 4), desktop shortcut trigger (T9), programmatic-access prompt documented (T6 step 2), zero tokens (no AI anywhere).
- Type consistency: MailItem and RowSet shapes defined once in Global Constraints and referenced by T5/T6/T7; function names checked (`Get-WlConfig`, `Get-WlState`, `Save-WlState`, `Get-WlScanStart`, `ConvertTo-ProjectName`, `Get-TaskCode`, `Resolve-SalesRep`, `Test-IgnoredSender`, `New-LogRows`, `Read-OutlookItems`, `Get-SenderStats`, `Update-WlWorkbook`).
- Placeholders: none — every code step shows full code; manual COM verifications have exact commands and expected outputs.
