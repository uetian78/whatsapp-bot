# Share several files to WhatsApp at once — design

Approved 2026-11-19. Small change, HVAC Assistant web app (`/app`), branch `feat/chat-web-app`.

## Why
Each file card has its own "Share to WhatsApp" button, so sending a "📦 Send all" batch means
picking the contact once per file. The user wants to send several documents in one share.

## Goals / non-goals
- Goal: tick any file cards (even from different searches) and share them in one share sheet.
- Non-goal: changing the server, zipping files, changing the single-card Share button.
- Anti-goal: anything that makes the single-file flow slower or downloads files nobody chose.

## Approaches
- **Client-side multi-file `navigator.share({ files })` (picked).** The server already serves each
  file and makes 7-day share links; the phone's share sheet accepts several files.
- Server builds a .zip: rejected — WhatsApp shows one .zip, not readable PDFs.
- One "Share all" button per batch: rejected by the user in favour of tick boxes.

## Design
- Tick box on each Drive file card (not on old `gen:` cards whose file is gone).
- Ticking a file that can be shared as a file (size known, ≤ 25 MB, browser can share files)
  downloads it at once and keeps it in memory, pinned, until it's unticked or shared.
- A bar above the message box while anything is ticked: `N selected · size  [Clear] [Share N files]`.
  While downloads run: "Getting files… x/N". If the phone no longer counts the tap: "Tap again to share".
- At most 10 ticked files; an 11th shows a toast.
- Files over 25 MB, unknown size, or browsers that can't share files go as links: after the
  files are shared the bar offers "Send N links", which opens wa.me with one line per file
  (name + 7-day link). If every ticked file is a link file, the main button sends the links directly.
- After a successful share the ticks clear; closing the share sheet keeps them.
- A file that fails to download: toast, and it is unticked.

## Left to the builder
Exact styling (match existing `.btn`, card and composer styles), helper names, test layout.
