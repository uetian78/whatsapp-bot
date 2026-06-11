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

// Each option: n (number), title (menu line), tip (sent when picked).
const MENU_OPTIONS = [
  {
    n: 1,
    title: "VRF Selection (Toshiba)",
    tip:
      "*VRF Selection — Toshiba SMMSe*\n" +
      "I build a full VRF BOQ from your room schedule (indoor + outdoor units + accessories).\n\n" +
      "👉 Send the exact words:\n*VRF Selection*\n\n" +
      "Then share your schedule as an *Excel / PDF / photo*, or type the rooms — I'll size every system and return a BOQ workbook.",
  },
  {
    n: 2,
    title: "MTZ Package Unit",
    tip:
      "*Trane MTZ Package Unit selector*\n" +
      "Answer 4 quick questions and I'll pick the model and generate a datasheet PDF.\n\n" +
      "👉 Just type:\n*MTZ*",
  },
  {
    n: 3,
    title: "APMR Packaged Unit (by capacity)",
    tip:
      "*APMR packaged unit selection*\n" +
      "Tell me the capacity in tonnage (TR) or airflow (CFM); I'll suggest the model and T1/T3 options.\n\n" +
      "👉 Examples (copy & send):\n" +
      "• *package unit 20 tr t3*\n" +
      "• *5000 cfm package unit*",
  },
  {
    n: 4,
    title: "Fresh Air / DOAS (PAC4A)",
    tip:
      "*PAC4A fresh-air (DOAS) selection*\n" +
      "Give me the required tonnage and I'll size the fresh-air unit.\n\n" +
      "👉 Examples:\n" +
      "• *fresh air 15 tr*\n" +
      "• *pac4a 10 tr*",
  },
  {
    n: 5,
    title: "Catalogues & IOM manuals",
    tip:
      "*Catalogues & IOM manuals*\n" +
      "Name the series, then add *catalogue* or *IOM*.\n\n" +
      "👉 Examples:\n" +
      "• *APMR catalogue*\n" +
      "• *APMR IOM*\n" +
      "• *MAH catalogue*  (air handling unit)\n" +
      "• *APCY-H catalogue*",
  },
  {
    n: 6,
    title: "Datasheets (T1 / T3)",
    tip:
      "*Model datasheets*\n" +
      "Send the series + 5-digit model code. Add *T1* or *T3* to get that one directly; otherwise I'll show both.\n\n" +
      "👉 Examples:\n" +
      "• *APMRa 51004*\n" +
      "• *APMR 52340 T1*",
  },
  {
    n: 7,
    title: "Chillers (APCY-E / APCY-H)",
    tip:
      "*APCY-E / APCY-H chillers*\n" +
      "Select by tonnage, look up a model, or get a datasheet.\n\n" +
      "👉 Examples:\n" +
      "• *APCY-H 30 tr*  (selection)\n" +
      "• *APCY5530TH datasheet*\n" +
      "• *APCY-H catalogue*",
  },
  {
    n: 8,
    title: "Fan Coil Units (FCU)",
    tip:
      "*Fan Coil Units (DMP / DCMP)*\n" +
      "Type *fcu* for the menu, or select by tonnage.\n\n" +
      "👉 Examples:\n" +
      "• *fcu*\n" +
      "• *DMP 10 tr*",
  },
  {
    n: 9,
    title: "Other brands (Hisense, etc.)",
    tip:
      "*Other brands*\n" +
      "Name the brand and the document you want.\n\n" +
      "👉 Examples:\n" +
      "• *Hisense catalogue*\n" +
      "• *Hisense VRF*\n\n" +
      "More brands are added as we receive them — if you don't get it, email hassan.saleem@mannai.com.qa.",
  },
  {
    n: 10,
    title: "Talk to a human / something else",
    tip:
      "*Need something else?*\n" +
      "For pricing, stock, or anything I can't find, email:\n*hassan.saleem@mannai.com.qa*\n\n" +
      MENU_HINT,
  },
];

const NUM = ["", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

// Build the welcome message (numbered list) + the options array to remember.
function welcomeMenu() {
  const line = (o) => `${NUM[o.n] || o.n + "."} ${o.title}`;
  const pick = (ns) => ns.map((n) => line(MENU_OPTIONS[n - 1])).join("\n");
  const text =
    "👋 *Welcome to the Mannai HVAC Assistant*\n" +
    "I help you *select equipment* and *fetch documents*.\n" +
    "Reply with a *number* to see exactly how to ask:\n\n" +
    "*— Selection engines —*\n" +
    pick([1, 2, 3, 4]) + "\n\n" +
    "*— Documents —*\n" +
    pick([5, 6, 7, 8, 9]) + "\n\n" +
    "*— Help —*\n" +
    line(MENU_OPTIONS[9]) + "\n\n" +
    "💡 Or just type what you need, e.g. *APMR catalogue* or *APMRa 51004*.";
  return { text, options: MENU_OPTIONS };
}

// Tip text for a chosen number (or null if out of range).
function tipFor(n, options = MENU_OPTIONS) {
  const opt = options.find((o) => o.n === n);
  return opt ? opt.tip : null;
}

module.exports = { isMenuTrigger, welcomeMenu, tipFor, MENU_HINT, MENU_OPTIONS };
