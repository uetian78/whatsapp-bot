// ============================================================
//  "Polish with AI" for the Bot Sender app: turn the owner's
//  rough note into a clean WhatsApp message. Text-only, so it
//  runs on Haiku (vision work stays on Sonnet — see memory).
// ============================================================
const POLISH_MODEL = "claude-haiku-4-5-20251001";

const LANGUAGE_NAMES = { en: "English", ar: "Arabic" };

function buildPolishRequest({ text, language, instruction }) {
  const lang = LANGUAGE_NAMES[language] || "English";
  const system =
    `You write WhatsApp messages on behalf of an HVAC equipment supplier (Mannai). ` +
    `Rewrite the user's note as a clear, polite, concise WhatsApp message in ${lang}. ` +
    `Keep every fact, number, model code, date and name exactly as given. ` +
    `Do not invent details, prices, promises or signatures. ` +
    `Output only the message text — no quotes, no preamble, no explanation.`;
  let content = `Note to turn into a message:\n${text}`;
  if (instruction) content += `\n\nExtra instruction: ${instruction}`;
  return {
    model: POLISH_MODEL,
    max_tokens: 600,
    system,
    messages: [{ role: "user", content }],
  };
}

async function polishDraft(client, opts) {
  const msg = await client.messages.create(buildPolishRequest(opts));
  return (msg.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

module.exports = { buildPolishRequest, polishDraft, POLISH_MODEL };
