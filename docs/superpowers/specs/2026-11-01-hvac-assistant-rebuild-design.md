# HVAC Assistant: new plan after the Meta lock

**Date:** 2026-11-01
**Status:** Approved in its 3-person version. Nothing has been built.
**Scope:** Every bot feature except the insides of the VRF and split selection engines, which stay as they are.
**Who it's for (your decision):** you and 2 other people.

## 1. The short version

Don't start from scratch. Keep the engines and product data, and make the smallest change that lets the bot work without one Meta account.

- **Build:** a chat-style phone web app that does everything the bot does. Every file has a "Share to WhatsApp" button.
- **Bring real WhatsApp chat back later, if needed:** only once a company stands behind the account, ideally Mannai. That would need the larger reorganization this version skips.

## 2. What your own data says

From the CRM log (12 Jun to 1 Nov 2026), the control sheet and the Drive library:

| Fact | Number | What it means |
|---|---|---|
| Messages | 949 | Low volume, so reliability matters more than scale |
| People | 3 | One number sent 848 messages (89%), so the pilot hasn't had real outside use yet |
| Numbers marked paid | 0 of 3 | Text AI answers are currently off for everyone |
| Files delivered | 153 | Schedule report and APMR-A catalogue lead (12 each) |
| Library | 529 files | Datasheets 234, Submittal Files 194, Catalogues 63, IOM 38 |
| Library requests | 5 | 1 still open |

**What people actually ask for:** mostly paperwork for submittals (company profiles, ISO certificates, authorization letters, test reports) and catalogues, then selections.

**Limits of this data:**
- 56 messages are logged with no reply, but the log closes after 8 seconds, so a slow file send looks the same as a failure.
- The 327 "other" messages are mostly older rows and steps inside guided flows, so they don't show unmet demand.

## 3. Ways to stay on WhatsApp

| Option | Real chat in WhatsApp? | What it needs | Verdict |
|---|---|---|---|
| A. Company-backed official account (Mannai) | Yes | Company approval and verification, a real number, a payment method | **Best WhatsApp route, if Mannai agrees** |
| B. Your own official account with a real SIM | Yes | The lock lifted, a payment method. I couldn't find whether a person with no registered business qualifies | Keep asking Meta, but don't depend on it |
| C. Stay on Meta's test number | Yes, 5 listed people | The lock lifted | Retire: it dropped out repeatedly, disappeared once, and is now blocked |
| D. Reseller (Twilio, 360dialog and others) | Yes | Still Meta's rules and business checks | Doesn't solve the problem |
| E. Twilio sandbox | Yes, on a shared number | Each user re-joins every 3 days, no custom templates | Short demos only |
| F. Unofficial tools (Baileys, whatsapp-web.js) on a spare SIM | Yes | Nothing from Meta | **No.** Breaks WhatsApp's terms and can get the number banned. Baileys has also had a critical security flaw and malicious copies on npm |
| G. Meta Business Agent | Yes | An account in good standing, about 4 to 5 US cents per message | No: I found nothing showing it can run your engines |
| H. Free Business app plus web app | Greeting only; results are shared into any chat | A spare SIM | **Recommended now** |
| I. Telegram bot | No, a different app | Nothing from Meta, but users must install Telegram; 50 MB file limit | Optional add-on |

**Two Meta changes that affect any official route:**
- Since 1 Oct 2026, Meta charges per delivered bot reply, and says it stops delivering replies for accounts with no payment method on file.
- Since 15 Jan 2026, general-purpose AI assistants are banned from the platform, while business support bots remain allowed. So the assistant must stay an HVAC tool, not open-ended chat.

## 4. What stays, changes and goes

**Keep:**
- Product data and engines: `products.js`, `chillers.js`, `mtz-engine.js`, `split-engine.js`, `vrf/`, `vrf-sidecar/`, `schedule-select.js`
- The PDF generators
- Google Drive as the library, and Google Sheets for anything people edit or read (allowed users, CRM dashboard)
- All 163 passing tests

**Change:**
- Replies in `server.js` go through a small send layer, so the web app can draw them. The main file otherwise stays as it is.
- Conversation memory is saved, so it survives restarts.
- Text AI moves to the newer Haiku model.

**Remove:**
- Free and paid plans. With 0 paid numbers they only block AI, and the "upgrade to PAID" and "AI credits" wording could make the bot look like a paid AI service. Replace with one monthly spending cap on text AI.
- The "Search with AI?" permission prompt. An AI search should now cost about a tenth of a US cent.
- The sheet keyword rules: their file links are all empty, so they only ever produce not-found replies.

**Set aside until WhatsApp returns:** the webhook, Bot Sender and automatic re-registration of the number. They're off unless `WHATSAPP_ENABLED=true`.

**Left out for 3 people (your decision):**
- The full reorganization of `server.js` and its long `if` chain
- Merging the overlapping document searches; PDF page search is added alongside them
- The webhook signature check, because WhatsApp is off. It must be added before WhatsApp is ever turned on
- Plain-English requests; commands and buttons work, and written questions still go to AI
- Logging fixes
- The Sonnet comparison; photo reading stays on the current model
- The WhatsApp Business app greeting

## 5. How it fits together

```
 Chat web app  ──►  server.js (existing routing)  ──►  Document and PDF page search
       ▲            Remembered conversation            Quick selection, chillers
       │                                               MTZ, split, VRF engines
       └── Send layer: text, choices, files  ◄──────   Schedule reader, reports
```

- **Chat-style web app (your request):** the main screen looks like a chat bot, with bubbles, tappable buttons, a message box and an attach button for photos and PDFs. File cards carry Open and "Share to WhatsApp".
- **Send layer:** the bot's replies become text, choices and files, and the app draws them as bubbles, buttons and cards.
- **The safety rule stays:** every capacity and spec comes from your engines or data, never from the AI's own memory.
- **Saved data:** a small SQLite database holds conversations, results and the document index. Sheets stays the place people edit and read.

## 6. Build order

Times are rough working days of build time.

| Phase | What | Done when | Time |
|---|---|---|---|
| 0. Safety fixes | Section 8, on the live service | Those items closed, tests pass | 0.5 day |
| 1. Core and PDFs | Send layer, saved data, newer AI model, search inside the PDFs, and single-page delivery | All 949 logged messages replay with the same or better result | About 2 days |
| 2. Web app | Check phone sharing first, then sign-in, chat screen, schedule check and sharing | The 3 of you complete your usual jobs on your own phones | 2 to 3 days |
| 3. Real use | You and the 2 others use it for your normal work | You know what's useful and what's missing | Calendar time |
| 4. Features | Build from section 7, based on what you find | Each one is used, or removed | Per feature |
| 5. WhatsApp chat, if ever | Reorganize, add the signature check and the WhatsApp front door, once there is a legitimate account | Same replay test passes on WhatsApp | Several days |

Total for phases 0 to 2: about 4 to 6 working days.

**Check first:** whether sharing a PDF into WhatsApp from the browser works on your testers' actual phones. Browser docs list PDF as usually shareable, but none confirm WhatsApp as a target, so this needs a quick test on iPhone and Android before phase 2.

## 7. Better features

| Feature | Why, from your history | Effort |
|---|---|---|
| **Search inside documents** with page references (in the first build, at your request) | Search only reads file names today, so "Trane country of origin" can't find its answer | Medium |
| **Just the matching page,** as a one-page PDF or an image (in the first build, at your request) | Nobody should need a whole 96 MB catalogue to answer one question or share one table | Small to medium |
| **Check-the-schedule screen:** edit what was read before selecting (in the first build) | Schedule report is your top output, and you've said accuracy comes first | Small to medium |
| **Plain-English requests** that run the engines (later) | "5kw, hi wall, 46" should start a split selection | Small to medium |
| **One-tap submittal pack:** one merged PDF with cover and index | Your most common request, and the Submittal Maker now only runs on your PC | Medium to large |
| **Saved projects and history** | "Print" was sent 28 times, but results expire after 30 minutes | Small |
| **Library check:** missing datasheets, expiring certificates, and telling people when a requested file arrives | Selection buttons have dead-ended on missing sheets, and the bot promises "within a few minutes" with nothing behind it | Small |
| **Bot doctor:** one health page plus an email alert | Would have shown today's problems in one screen, and an alert still works when WhatsApp is down | Small |
| **Engineering calculators** | `psychro-engine.js` is finished but nothing uses it | Small |

**PDF search, measured on 1 Nov 2026.** Your Drive holds 518 PDFs, 1.48 GB in total. I tested 20 of them, picked across all four folders:
- **Readable text:** 19% of the pages had almost no text, and 3 files were scanned images only. These are mostly submittal papers, such as an authorization letter and a country of origin certificate.
- **Speed:** searches took under 2 milliseconds. Reading the whole library once should take roughly 20 minutes, based on this sample.
- **Scanned pages (your decision):** they won't be read. Those files can still be found by file name, but their contents won't appear in search results.

**Running on Railway Free (your decision).** Railway keeps only the searchable text; the PDFs stay in Drive.
- **Memory:** Free allows 0.5 GB, and my test reached 527 MB. So your PC reads the full library once and uploads the search file. The server reads new or changed PDFs up to 10 MB by itself. Larger ones wait for the next PC run.
- **Single pages:** the app downloads the PDF to temporary storage and uses two small tools, `qpdf` and `pdftoppm`, to pull out one page. I couldn't test these here, so go-live tests them on the 119 MB file. Above the largest size that works, people get the full file instead.
- **Sleep:** the app sleeps 5 to 10 minutes after its last network activity, so the first message after a quiet period is slower.
- **Credit:** the $1 monthly credit should cover roughly 100 to 150 hours awake (my estimate), which should suit 3 people. If it runs out, I expect the app to stop until the credit renews. Hobby at $5 a month is the fallback.

Later ideas: compliance statement drafts (you already have the skill), voice notes and Arabic, budget quotes from a privately uploaded price list.

## 8. Problems found in the current bot

**Fix now (phase 0):**

| Problem | Where | Risk |
|---|---|---|
| Webhook messages aren't verified as coming from Meta | `server.js:2443` | Anyone with the address can fake a message and spend your credit. Closed by switching the webhook off |
| The file list is public with no login (I confirmed it answers) | `server.js:2481` | Anyone can read all 529 file names |
| The allowed-numbers check runs too late | `server.js:1974` | Buttons, the menu and all guided flows run first, so an unknown number can trigger paid Sonnet schedule reading |
| Numbers not on the list count as AI-allowed | `lib/accounts.js:66` | Same as above |
| `stats` is open to everyone if `ADMIN_NUMBERS` isn't set | `server.js:2006` | Usage details are exposed. I can't see whether it's set on Railway |
| 11 known dependency issues (1 critical, 5 high) | `package.json` | `xlsx` has no fix on npm and reads uploaded files; most others can be fixed by updating |
| Key files aren't excluded from Docker builds | `.dockerignore` | Only matters if you deploy from your PC rather than GitHub |

**Fix during the build:**

| Problem | Where | Effect |
|---|---|---|
| MTZ one-line shortcut can never run, though the menu advertises it | `server.js:1932`, `menu.js:96` | Users get the wrong result |
| "Get it in minutes" promise | `lib/doc-requests.js:14` | Depends on a person seeing the alert in time |
| Library re-scanned folder by folder, and every file name is logged | `lib/drive-index.js:86` | Slow after a restart, noisy logs |
| Old Haiku model hard-coded | `server.js` | Paying more than needed |
| Bot is called "Mannai HVAC Assistant" without Mannai's approval | `menu.js:141` | Use a neutral name unless Mannai approves |

Failed WhatsApp sends and the usage log's timing stay as they are, because WhatsApp is off.

## 9. Costs

| Item | Now | Proposed |
|---|---|---|
| Text AI (per million tokens, in / out) | Haiku 4.5: $1 / $5 | Haiku 5.5: $0.10 / $0.50 |
| Reading photos (per million tokens, in / out) | Sonnet 4.6: $3 / $15 | Unchanged, and not counted by the monthly cap |
| One AI search | About 1 cent | About a tenth of a cent |
| One schedule photo | Several cents | Several cents |
| Meta | None on the test number | None for the web app; per delivered reply on an official account |
| Hosting | Your current Railway plan | Railway Free: $0 with $1 of monthly credit, which also pays for the storage volume (about 2 US cents a month for 100 MB). Hobby at $5 a month if the credit runs out |

AI costs are my estimates from published prices, and need measuring. Rates for Qatar still need checking on Meta's rate card.

## 10. Decisions

**Yours, already made:**
- No registered business, and this is a pilot
- Text AI on Haiku, photo reading on Sonnet
- VRF and split engines left alone
- Never invent specs
- Prices are never stored
- The web app looks and works like a chat bot
- The PDFs in Drive become searchable in the first build
- Search covers PDFs that already have text; scanned pages are not read by AI
- Host on Railway's Free plan, keeping only the searchable text there
- People can get just the matching page, as a one-page PDF or an image
- Only you and 2 others will use it, so the plan is the smaller version

**My calls, which you can overrule:**
- Web app first
- Stay on Node and Express, and on Railway, so only one big thing changes at a time
- SQLite on a Railway volume, which fits a single server and this volume
- Personal invite links for login: no passwords, no email service, and access removed from the Sheet
- Neutral product name, "HVAC Assistant"

**Left to the builder:** web page framework, PDF text extraction library, exact database tables.

## 11. What this is not

- Not a general AI chat: it stays an HVAC tool
- Not a company-wide or paid product until real users prove the need
- No false company details on Meta, no unofficial WhatsApp tools, and no new accounts to get around the lock
- No rewrite of the selection engines

## 12. Questions for you

1. Will Mannai put its name on this? A yes moves real WhatsApp chat up, using option A.
2. Do the 3 of you use iPhone or Android? This decides which phones the sharing test covers.

The 3 of you will see everything, including the 194 Submittal Files. That's my assumption, so tell me if it's wrong.

## Sources

- [Meta: pricing updates for service messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages)
- [Meta: pricing policy for AI Providers](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers)
- [Meta: messaging limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits)
- [Meta: registering a business phone number](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration/)
- [TechCrunch: WhatsApp bars general-purpose chatbots](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform)
- [Twilio: WhatsApp sandbox](https://www.twilio.com/docs/whatsapp/sandbox)
- [Telegram: Bot API](https://core.telegram.org/bots/api)
- [MDN: Navigator.share()](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share)
- [Snyk: Baileys security advisory](https://security.snyk.io/vuln/SNYK-JS-BAILEYS-17818154)
