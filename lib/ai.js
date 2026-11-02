// ============================================================
//  Text AI behind one spending cap.
//  Every text-only Claude call in the bot goes through createAi():
//   - Haiku 5.5 by default (AI_TEXT_MODEL overrides), effort set with
//     output_config. Thinking counts toward max_tokens, so max_tokens is never
//     below 1024. No temperature/top_p/top_k: Haiku 5.5 rejects non-default values.
//   - each answered call is written to ai_usage with its tokens and cost, and
//     the sum for the current UTC month is held under a cap (AI_MONTHLY_CAP_USD).
//   - a call returns null — never throws — on an API error, a refusal, or a
//     reply cut off before any text, so callers keep their "no answer" path.
//  Everything is injected so tests use a fake client and ":memory:". `client`
//  may be null (no API key); `db` may be a function, called once on first need,
//  so building the instance never opens a database.
// ============================================================
const { isCreditError, isExhausted, markExhausted } = require("./ai-credits.js");

const DEFAULT_MODEL = process.env.AI_TEXT_MODEL || "claude-haiku-5-5";
const DEFAULT_CAP_USD = Number(process.env.AI_MONTHLY_CAP_USD || 10);

// Thinking counts toward max_tokens, so anything lower can end with no text.
const MIN_MAX_TOKENS = 1024;

// USD per million tokens: input, output, and the rates for a prompt over
// 100K tokens. Cache reads cost 0.1x input; 5-minute cache writes cost 1.25x.
const LONG_PROMPT_TOKENS = 100000;
const RATES = {
  "claude-haiku-5-5": { input: 0.10, output: 0.50, longInput: 0.50, longOutput: 2.50 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
};
// A model we have no rate for is costed at the dearest rate, so the cap errs
// on the side of stopping early.
const UNKNOWN_RATE = { input: 10, output: 50 };

const CACHE_READ_X = 0.1;
const CACHE_WRITE_X = 1.25;

const num = (n) => (Number.isFinite(n) ? n : 0);

// `tiered` applies the long-prompt rates (a prompt over 100K tokens). The bot's
// prompts are far smaller, so this only guards the cap against a surprise.
function costUsd(model, usage, tiered = false) {
  const u = usage || {};
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const read = num(u.cache_read_input_tokens);
  const write = num(u.cache_creation_input_tokens);
  const rate = RATES[model] || UNKNOWN_RATE;
  const long = tiered && input + read + write > LONG_PROMPT_TOKENS && rate.longInput !== undefined;
  const inRate = long ? rate.longInput : rate.input;
  const outRate = long ? rate.longOutput : rate.output;
  return (input * inRate + output * outRate + read * inRate * CACHE_READ_X + write * inRate * CACHE_WRITE_X) / 1e6;
}

// The reply's text only: thinking (and any other) blocks are skipped. Never read
// content[0] — with thinking on, the first block is not necessarily text.
function textOf(message) {
  const blocks = Array.isArray(message && message.content) ? message.content : [];
  return blocks.filter((b) => b && b.type === "text").map((b) => b.text || "").join("");
}

// What went wrong, with no message text: that can carry the question or the
// document names we sent.
function describeError(err) {
  const apiType = err && err.error && err.error.error && err.error.error.type;
  return [
    (err && err.name) || "Error",
    err && err.status ? `status=${err.status}` : null,
    apiType ? `type=${apiType}` : null,
  ].filter(Boolean).join(" ");
}

function monthBounds(ms) {
  const d = new Date(ms);
  return [Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)];
}

function createAi({ client, db, now = Date.now, capUsd = DEFAULT_CAP_USD, model = DEFAULT_MODEL } = {}) {
  let handle = null;
  let statements = null;
  const stmts = () => {
    if (!statements) {
      handle = typeof db === "function" ? db() : db;
      statements = {
        sum: handle.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ai_usage WHERE ts >= ? AND ts < ?"),
        add: handle.prepare(
          "INSERT INTO ai_usage (ts, purpose, model, input, output, cache_read, cache_write, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
      };
    }
    return statements;
  };

  function spendThisMonth() {
    const [from, to] = monthBounds(now());
    return stmts().sum.get(from, to).total;
  }

  // No key, the credit latch is set, or the month's cap is reached. If the
  // usage table can't be read the cap can't be checked, so AI stays off.
  function available() {
    if (!client || isExhausted()) return false;
    try {
      return spendThisMonth() < capUsd;
    } catch (err) {
      console.error(`AI usage unreadable, AI off: ${describeError(err)}`);
      return false;
    }
  }

  function record(purpose, usedModel, usage) {
    const u = usage || {};
    try {
      stmts().add.run(now(), purpose, usedModel, num(u.input_tokens), num(u.output_tokens),
        num(u.cache_read_input_tokens), num(u.cache_creation_input_tokens), costUsd(usedModel, u, true));
    } catch (err) {
      console.error(`AI usage not recorded (${purpose}): ${describeError(err)}`);
    }
  }

  async function askMessage(params) {
    const { purpose = "unknown", effort = "low", temperature, top_p, top_k, ...rest } = params || {};
    if (!available()) return null;
    const request = {
      ...rest,
      model: rest.model || model,
      max_tokens: Math.max(MIN_MAX_TOKENS, num(rest.max_tokens)),
      output_config: { effort, ...rest.output_config },
    };
    let message;
    try {
      message = await client.messages.create(request);
    } catch (err) {
      console.error(`AI error (${purpose}, ${request.model}): ${describeError(err)}`);
      if (isCreditError(err)) markExhausted();
      return null;
    }
    // Refusals and cut-off replies are billed too.
    record(purpose, request.model, message && message.usage);
    if (!message || message.stop_reason === "refusal") {
      console.error(`AI refused (${purpose}, ${request.model})`);
      return null;
    }
    if (message.stop_reason === "max_tokens" && !textOf(message).trim()) {
      console.error(`AI ran out of tokens before answering (${purpose}, ${request.model})`);
      return null;
    }
    return message;
  }

  async function askText({ purpose, system, user, maxTokens = MIN_MAX_TOKENS, effort = "low" }) {
    const message = await askMessage({
      purpose, effort, system, max_tokens: maxTokens, messages: [{ role: "user", content: user }],
    });
    return (message && textOf(message).trim()) || null;
  }

  return { available, spendThisMonth, askText, askMessage };
}

module.exports = { createAi, textOf, costUsd, DEFAULT_MODEL, DEFAULT_CAP_USD, RATES };
