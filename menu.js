// ============================================================
//  WELCOME MENU + "HOW TO ASK" TIPS
//  A greeting / "menu" / "help" shows the three-row menu (Documents, Chiller
//  and package selection, Help). Replying with a number, or tapping a row,
//  sends that section's tip card, with copy-paste example messages that
//  tests/menu.test.js checks are requests the app understands.
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

// Each option: n (the number typed to pick it), id (the row's tap id), title
// (menu line), tip (sent when picked). The ids are the ones the rows had before
// the menu shrank to three (Help was row 6), so an old row still on someone's
// screen opens the same tip or nothing, never a different one.
const MENU_OPTIONS = [
  {
    n: 1,
    id: "menu|1",
    title: "Documents (Catalogues, IOM & Datasheets)",
    short: "Documents",
    desc: "Catalogues, IOM manuals & model datasheets",
    tip:
      "*📄 Documents*\n" +
      "Get a catalogue, IOM manual, or model datasheet. I'll send the PDF to your chat.\n\n" +
      "👉 Examples (copy & send):\n" +
      "• Catalogue: *APMR catalogue*\n" +
      "• IOM manual: *APMR IOM*\n" +
      "• Air handling unit: *MAH catalogue*\n" +
      "• Chiller: *APCY-H catalogue*\n" +
      "• Datasheet (model code): *APMRa 51004*  or  *APMR 52340 T1*\n" +
      "• Other brands: *Hisense catalogue*\n" +
      "• Not sure of the exact name? Type a few words from it: *find coil connection sheet*",
  },
  {
    n: 2,
    id: "menu|2",
    title: "Chiller & Package Selection",
    short: "Chiller and package",
    desc: "Capacity in, model and datasheet out",
    tip:
      "*🛠️ Chiller & Package Selection*\n" +
      "Tell me the capacity and I'll pick the model, with its datasheet.\n\n" +
      "👉 Examples:\n" +
      "• Packaged unit: *package unit 20 tr t3*  or  *5000 cfm package unit*\n" +
      "• Fresh air / DOAS: *fresh air 15 tr*\n" +
      "• Chiller: *APCY-H 30 tr*\n" +
      "• Fan coil unit: *DMP 10 tr*  (or type *fcu*)",
  },
  {
    n: 3,
    id: "menu|6",
    title: "Help (how to use this assistant)",
    short: "Help",
    desc: "How to ask, with copy-paste examples",
    tip:
      "*🙋 How to use this assistant*\n" +
      "I find documents and pick chillers and packaged units. I don't answer written questions about specs: ask for the datasheet or catalogue instead.\n\n" +
      "1️⃣ *Find a document* — product + *catalogue* / *IOM*, or a model code.\n" +
      "   e.g. *APMR catalogue*, *APMRa 51004*\n\n" +
      "2️⃣ *Select a unit* — capacity + type.\n" +
      "   e.g. *package unit 20 tr*, *APCY-H 30 tr*\n\n" +
      "📋 *See a whole range* — *list APMR units*, *APMRG1 list* (also PAC4A, DMP, chillers…)\n\n" +
      "🔎 If I can't find a name I suggest the closest files. Still nothing? Tap *Request it* and the team will add it.\n\n" +
      "Type *menu* anytime. For anything else: *hassan.saleem@mannai.com.qa*",
  },
];

const NUM  = ["", "1️⃣", "2️⃣", "3️⃣"];
const ICON = ["", "📄", "🛠️", "🙋"];

// The option a row's tap id opens, or null (an id this menu no longer has).
function optionForTap(id) {
  return MENU_OPTIONS.find((o) => o.id === id) || null;
}

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
    "_HVAC Assistant_ — catalogues, datasheets & chiller and package selection.\n" +
    "━━━━━━━━━━━━━━\n" +
    "Reply with a *number*:\n\n" +
    MENU_OPTIONS.map(line).join("\n") + "\n" +
    "━━━━━━━━━━━━━━\n" +
    "💡 Or just type what you need — e.g. *APMR catalogue* · *APCY-H 30 tr*";
  return { text, options: MENU_OPTIONS };
}

// Tip text for a chosen number (or null if out of range).
function tipFor(n, options = MENU_OPTIONS) {
  const opt = options.find((o) => o.n === n);
  return opt ? opt.tip : null;
}

// Native list-message version of the welcome menu. Rows tap straight into the
// same tips as the numbered replies (each row's own id), so both entry paths work.
function welcomeMenuList(name, returning) {
  const first = (name || "").trim().split(/\s+/)[0];
  const hello = first
    ? (returning ? `👋 *Welcome back, ${first}!*` : `👋 *Welcome, ${first}!*`)
    : "👋 *Welcome!*";
  const body =
    `${hello}\n_HVAC Assistant_ — catalogues, datasheets & chiller and package selection.\n\n` +
    "Tap below to see what I can do — or just type what you need, e.g. *APMR catalogue* · *APCY-H 30 tr*.";
  return {
    body,
    buttonLabel: "What I can do",
    rows: MENU_OPTIONS.map((o) => ({
      id: o.id,
      title: `${ICON[o.n] || ""} ${o.short}`.trim().slice(0, 24),
      description: (o.desc || "").slice(0, 72),
    })),
    options: MENU_OPTIONS,
  };
}

module.exports = { isMenuTrigger, smallTalkReply, welcomeMenu, welcomeMenuList, tipFor, optionForTap, MENU_HINT, MENU_OPTIONS };
