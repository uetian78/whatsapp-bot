// ============================================================
//  WELCOME MENU + "HOW TO ASK" TIPS
//  A greeting / "menu" / "help" shows a numbered list (10 items).
//  Replying with a number sends that section's tip card, with
//  copy-paste example messages that are VERIFIED (see test-menu.js)
//  to trigger the matching handler in server.js.
//
//  Convention (matches sendFileOptions): <=3 choices use tappable
//  buttons; >3 choices use a numbered list. The top menu has 10
//  items, so it's a numbered list the user replies to with a number.
// ============================================================

// Greeting / menu / help trigger. Matches ONLY when the whole message is a
// greeting or menu word, so it never hijacks a real request such as
// "hi can I get the APMR catalogue".
function isMenuTrigger(text) {
  const t = (text || "").trim().toLowerCase().replace(/[!.,?]+$/g, "").trim();
  if (!t) return false;
  return /^(hi|hello|hey|hiya|yo|hi there|menu|main menu|help|start|\/start|begin|option|options|list|salam|assalam(?:u? ?alaikum)?|good (?:morning|afternoon|evening)|gm)$/.test(t);
}

// Shown on not-found replies and at the end of the human-handoff tip.
const MENU_HINT = "💡 Type *menu* anytime to see everything I can do.";

// Conversational closings / acknowledgements (whole-message match only, so it
// never hijacks a real request). Returns a friendly reply, or null. Used to
// short-circuit BEFORE the "searching our library" notice and the AI fallback,
// so "bye" / "exit" / "thanks" don't trigger a document search.
function smallTalkReply(text) {
  const t = (text || "").trim().toLowerCase().replace(/[!.,?]+$/g, "").trim();
  if (!t) return null;
  if (/^(thanks?|thank you|thankyou|thx|tysm|ty|shukran|shukraan|much appreciated|appreciated|thanks a lot|thank u|great thanks|thank you so much)$/.test(t))
    return "You're welcome! 😊 Type *menu* anytime you need a catalogue, datasheet, or selection.";
  if (/^(bye|byee|goodbye|good bye|exit|quit|close|cancel|stop|end|done|finished|nothing|no thanks|no thank you|that'?s all|thats all|good ?night|see you|see ya|cya|take care)$/.test(t))
    return "👋 Anytime! Type *menu* whenever you need a catalogue, datasheet, or selection.";
  if (/^(ok|okay|okk|k|cool|great|nice|fine|alright|all right|got it|gotit|understood|noted|perfect|good|sounds good|👍|👌|🙏)$/.test(t))
    return "👍 Type *menu* anytime you need something.";
  return null;
}

// Each option: n (number), title (menu line), tip (sent when picked).
const MENU_OPTIONS = [
  {
    n: 1,
    title: "Document Search (Catalogues & IOM)",
    tip:
      "*📄 Document Search*\n" +
      "Get a catalogue, IOM manual, or model datasheet — I'll send the PDF to your chat.\n\n" +
      "👉 Examples (copy & send):\n" +
      "• Catalogue: *APMR catalogue*\n" +
      "• IOM manual: *APMR IOM*\n" +
      "• Air handling unit: *MAH catalogue*\n" +
      "• Chiller: *APCY-H catalogue*\n" +
      "• Datasheet (model code): *APMRa 51004*  or  *APMR 52340 T1*\n" +
      "• Other brands: *Hisense catalogue*",
  },
  {
    n: 2,
    title: "Quick Selection Tools (Package / AHU / Chiller)",
    tip:
      "*🛠️ Quick Selection Tools*\n" +
      "Tell me the capacity and I'll pick the model for you.\n\n" +
      "👉 Examples:\n" +
      "• Packaged unit: *package unit 20 tr t3*  or  *5000 cfm package unit*\n" +
      "• Fresh air / DOAS: *fresh air 15 tr*\n" +
      "• Chiller: *APCY-H 30 tr*\n" +
      "• Fan coil unit: *DMP 10 tr*  (or type *fcu*)",
  },
  {
    n: 3,
    title: "Guided Selectors (VRF / MTZ / Split)",
    tip:
      "*🧭 Guided Selectors — Step-by-step with PDF output*\n\n" +
      "━━━━━━━━━━━━━━\n" +
      "🏢 *VRF Selection* — Toshiba VRF BOQ\n" +
      "Type: *VRF Selection*\n" +
      "Upload a schedule or enter room loads → full BOQ + PDF report.\n\n" +
      "━━━━━━━━━━━━━━\n" +
      "🌡️ *MTZ Selection* — Trane Package Unit\n" +
      "Type: *MTZ Selection*\n" +
      "Steps: load → conditions (DB/WB/Amb) → airflow → ranked models + PDF.\n" +
      "⚡ Express: `MTZ Selection 8.5TR 80/67/115`\n\n" +
      "━━━━━━━━━━━━━━\n" +
      "🧊 *Split Selection* — Toshiba / TCL / SKM\n" +
      "Type: *Split Selection*\n" +
      "Steps: brand → unit list (one per line):\n" +
      "`load kW, type, DB/WB/Amb`\n" +
      "e.g. `5 kw, hi wall, 26.7/19.4/46`\n" +
      "• Auto-splits oversized loads into 2×, 3×, 4× units\n" +
      "• Reply *Print* after results for a PDF report\n" +
      "• Browse the range: *list of split units* (T1/T3 capacities)",
  },
  {
    n: 4,
    title: "Quick Questions about products",
    tip:
      "*❓ Quick Questions*\n" +
      "Ask about any product and I'll answer from our catalogue & datasheet data.\n\n" +
      "👉 Examples:\n" +
      "• *What is the cooling capacity of APMR 52340 at T3?*\n" +
      "• *How many TR is DMP 10?*\n" +
      "• *What's the EER of APCY5080DE?*\n" +
      "• *Difference between APCY-E and APCY-H?*\n\n" +
      "💡 If I don't have the answer, I'll point you to the team.",
  },
  {
    n: 5,
    title: "Help (how to use this bot)",
    tip:
      "*🙋 How to use this assistant*\n" +
      "Just type what you need — four ways:\n\n" +
      "1️⃣ *Find a document* — product + *catalogue* / *IOM*, or a model code.\n" +
      "   e.g. *APMR catalogue*, *APMRa 51004*\n\n" +
      "2️⃣ *Quick select* — capacity + type.\n" +
      "   e.g. *package unit 20 tr*, *fresh air 15 tr*\n\n" +
      "3️⃣ *Guided selectors* — step-by-step with PDF output:\n" +
      "   *VRF Selection* · *MTZ Selection* · *Split Selection*\n\n" +
      "4️⃣ *Ask a question* — in plain words.\n" +
      "   e.g. *How many TR is DMP 10?*\n\n" +
      "📋 *See a whole range* — *list APMR units* (also PAC4A, DMP, chillers…)\n\n" +
      "Type *menu* anytime. For anything else: *hassan.saleem@mannai.com.qa*",
  },
];

const NUM  = ["", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];
const ICON = ["", "📄", "🛠️", "🧭", "❓", "🙋"];

// Build the welcome message (numbered list) + the options array to remember.
// `name` = WhatsApp profile name (optional); `returning` = seen before (CRM).
function welcomeMenu(name, returning) {
  const first = (name || "").trim().split(/\s+/)[0];
  const hello = first
    ? (returning ? `👋 *Welcome back, ${first}!*` : `👋 *Welcome, ${first}!*`)
    : "👋 *Welcome!*";
  const line = (o) => `${NUM[o.n] || o.n + "."} ${ICON[o.n] || ""} *${o.title}*`;
  const text =
    `${hello}\n` +
    "_Mannai HVAC Assistant_ — documents, selections & product answers.\n" +
    "━━━━━━━━━━━━━━\n" +
    "Reply with a *number*:\n\n" +
    MENU_OPTIONS.map(line).join("\n") + "\n" +
    "━━━━━━━━━━━━━━\n" +
    "💡 Or just type what you need — e.g. *APMR catalogue* · *MTZ Selection* · *Split Selection*";
  return { text, options: MENU_OPTIONS };
}

// Tip text for a chosen number (or null if out of range).
function tipFor(n, options = MENU_OPTIONS) {
  const opt = options.find((o) => o.n === n);
  return opt ? opt.tip : null;
}

module.exports = { isMenuTrigger, smallTalkReply, welcomeMenu, tipFor, MENU_HINT, MENU_OPTIONS };
