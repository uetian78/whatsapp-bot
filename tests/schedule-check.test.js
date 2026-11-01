// The check-the-schedule table: applyRowEdits (pure), the table's message body,
// the channel facade/adapter pieces, and the schedule flow's step through the real
// server.js (replay harness; skipped when the private fixtures are not here).
const test = require("node:test");
const assert = require("node:assert");
const { normalizeRows } = require("../schedule-select.js");
const { applyRowEdits, rowCheckView, UNITS } = require("../lib/schedule-check.js");

const raw = [
  { location: "Room 1", type: "SPLIT", category: "split", capacity: 24000, unit: "BTU/HR", qty: 2 },
  { location: "Roof 1", type: "PACKAGE AC", category: "package", capacity: 10, unit: "TR", qty: 1, airflow: 4000, airflowUnit: "CFM", condition: "T3" },
  { location: "Hall", type: "DUCTED", category: "ducted", capacity: 7.5, unit: "", qty: 1 },
];
const fresh = () => {
  const n = normalizeRows(raw);
  return { rows: n.rows, skipped: [{ location: "Store", raw: "smudged" }, { location: "Lobby", raw: "??" }] };
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const edit = (id, fields) => ({ id, ...fields });

test("an edited capacity recalculates requiredKw", () => {
  const { rows, skipped } = fresh();
  const out = applyRowEdits(rows, skipped, [edit("r1", { value: 18, unit: "TR" })]);
  assert.deepEqual(out.errors, []);
  assert.equal(out.rows[1].srcValue, 18);
  assert.equal(out.rows[1].srcUnit, "TR");
  assert.ok(Math.abs(out.rows[1].requiredKw - 63.3) < 0.05, `got ${out.rows[1].requiredKw}`);
  assert.equal(out.rows[1].airflow, 4000, "fields the table does not show are kept");
  assert.equal(out.rows[1].condition, "T3");
});

test("a changed unit alone recalculates from the same number", () => {
  const { rows, skipped } = fresh();
  const out = applyRowEdits(rows, skipped, [edit("r0", { value: 24000, unit: "MBH" })]);
  assert.deepEqual(out.errors, []);
  assert.ok(Math.abs(out.rows[0].requiredKw - 24000 * 0.293071) < 0.05);
});

test("quantity, tag and type can change, and a changed type is classified again", () => {
  const { rows, skipped } = fresh();
  const out = applyRowEdits(rows, skipped, [edit("r0", { tag: "Room 1A", qty: "3", type: "ducted" })]);
  assert.deepEqual(out.errors, []);
  assert.equal(out.rows[0].location, "Room 1A");
  assert.equal(out.rows[0].qty, 3);
  assert.equal(out.rows[0].category, "ducted");
  assert.equal(out.rows[0].requiredKw, rows[0].requiredKw, "capacity untouched");
});

test("a fixed skipped row joins the rows, classified", () => {
  const { rows, skipped } = fresh();
  const out = applyRowEdits(rows, skipped, [edit("s0", { type: "package", value: 5, unit: "TR", qty: 2 })]);
  assert.deepEqual(out.errors, []);
  assert.equal(out.rows.length, 4);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].location, "Lobby");
  const joined = out.rows[3];
  assert.equal(joined.location, "Store", "keeps the tag it was read with");
  assert.equal(joined.category, "package");
  assert.equal(joined.qty, 2);
  assert.ok(Math.abs(joined.requiredKw - 17.58) < 0.05);
  // the same row shape as any row the reader makes
  assert.deepEqual(Object.keys(joined).sort(), Object.keys(rows[0]).sort());
  assert.equal(joined.condition, null);
});

test("a skipped row left blank stays skipped", () => {
  const { rows, skipped } = fresh();
  const out = applyRowEdits(rows, skipped, [edit("s0", { type: "", value: "", unit: "", qty: "" })]);
  assert.deepEqual(out.errors, []);
  assert.equal(out.rows.length, 3);
  assert.equal(out.skipped.length, 2);
});

test("a skipped row filled in halfway is an error naming it", () => {
  const { rows, skipped } = fresh();
  const out = applyRowEdits(rows, skipped, [edit("s1", { type: "split", value: 5, unit: "" })]);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /Lobby/);
  assert.deepEqual(out.rows, rows);
  assert.deepEqual(out.skipped, skipped);
});

test("a bad number names that row in errors and changes nothing", () => {
  const { rows, skipped } = fresh();
  const before = clone({ rows, skipped });
  for (const bad of ["abc", "", "-5", "0", "NaN", "Infinity", "1e999", {}, null, 1e9]) {
    const out = applyRowEdits(rows, skipped, [edit("r0", { qty: 5, tag: "changed" }), edit("r1", { value: bad, unit: "TR" })]);
    assert.equal(out.errors.length, 1, `value ${JSON.stringify(bad)}`);
    assert.match(out.errors[0], /Roof 1/);
    assert.deepEqual(out.rows, before.rows, "the good edit to r0 is not applied either");
    assert.deepEqual(out.skipped, before.skipped);
  }
  assert.deepEqual(clone({ rows, skipped }), before, "the inputs are never changed");
});

test("quantity below 1 is an error", () => {
  const { rows, skipped } = fresh();
  for (const bad of [0, -1, 1.5, "1.5", "two", "", 1000, null, NaN]) {
    const out = applyRowEdits(rows, skipped, [edit("r2", { qty: bad })]);
    assert.equal(out.errors.length, 1, `qty ${JSON.stringify(bad)}`);
    assert.match(out.errors[0], /Hall/);
    assert.deepEqual(out.rows, rows);
  }
});

test("a unit must be one the converter knows, and an unknown type is an error", () => {
  const { rows, skipped } = fresh();
  for (const unit of ["furlongs", "", "PSI", "kW; DROP", 5]) {
    const out = applyRowEdits(rows, skipped, [edit("r0", { value: 10, unit })]);
    assert.equal(out.errors.length, 1, `unit ${JSON.stringify(unit)}`);
    assert.match(out.errors[0], /Room 1/);
  }
  for (const u of UNITS) assert.deepEqual(applyRowEdits(rows, skipped, [edit("r0", { value: 100, unit: u })]).errors, [], u);
  assert.match(applyRowEdits(rows, skipped, [edit("r0", { value: 10, unit: "BTU/h" })]).errors[0], /sensible/, "rounds to nothing");
  const bad = applyRowEdits(rows, skipped, [edit("r0", { type: "mystery" })]);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /Room 1/);
});

test("strings are length-capped", () => {
  const { rows, skipped } = fresh();
  const out = applyRowEdits(rows, skipped, [edit("r0", { tag: "x".repeat(200) })]);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /Room 1/);
  assert.deepEqual(out.rows, rows);
});

test("untouched rows stay identical, even when the table sends every field back", () => {
  const { rows, skipped } = fresh();
  const view = rowCheckView(rows, skipped);
  const echoed = [...view.rows, ...view.skipped.map((s) => ({ id: s.id, tag: s.tag, type: "", value: "", unit: "", qty: "" }))];
  const out = applyRowEdits(rows, skipped, echoed);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.rows, rows);
  assert.deepEqual(out.skipped, skipped);
  // one edit leaves the other rows deep-equal
  const one = applyRowEdits(rows, skipped, echoed.map((e) => (e.id === "r1" ? { ...e, qty: 4 } : e)));
  assert.deepEqual(one.rows[0], rows[0]);
  assert.deepEqual(one.rows[2], rows[2]);
  assert.equal(one.rows[1].qty, 4);
});

test("the client can never set requiredKw or any computed field", () => {
  const { rows, skipped } = fresh();
  const out = applyRowEdits(rows, skipped, [edit("r0", { requiredKw: 999, category: "package", condition: "T1", onCoilDb: 1, airflow: 1, srcValue: 1, qty: 3 })]);
  assert.deepEqual(out.errors, []);
  assert.equal(out.rows[0].requiredKw, rows[0].requiredKw);
  assert.equal(out.rows[0].category, "split");
  assert.equal(out.rows[0].condition, rows[0].condition);
  assert.equal(out.rows[0].srcValue, 24000);
  assert.equal(out.rows[0].qty, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(out.rows[0], "__proto__"), false);
});

test("an id that is not in the table is an error, and so is a repeated id or junk", () => {
  const { rows, skipped } = fresh();
  for (const edits of [[edit("r9", { qty: 2 })], [edit("r0", { qty: 2 }), edit("r0", { qty: 3 })], [null], ["r0"], [{ qty: 2 }], "nope", undefined, {}]) {
    const out = applyRowEdits(rows, skipped, edits);
    assert.ok(out.errors.length >= 1, JSON.stringify(edits));
    assert.deepEqual(out.rows, rows);
    assert.deepEqual(out.skipped, skipped);
  }
});

test("a huge edit list is refused", () => {
  const { rows, skipped } = fresh();
  const many = Array.from({ length: 2000 }, (_, i) => edit("r0", { qty: 1 }));
  assert.ok(applyRowEdits(rows, skipped, many).errors.length >= 1);
});

test("rowCheckView lists tag, type, load, unit and quantity, and the skipped rows", () => {
  const { rows, skipped } = fresh();
  const v = rowCheckView(rows, skipped);
  assert.deepEqual(v.rows[0], { id: "r0", tag: "Room 1", type: "split", value: 24000, unit: "BTU/h", qty: 2 });
  assert.equal(v.rows[2].unit, "kW", "no unit printed means the engine took kW, and the table says so");
  assert.deepEqual(v.skipped[0], { id: "s0", tag: "Store", raw: "smudged" });
  assert.match(v.text, /3 rows/);
  assert.match(v.text, /2 .*couldn't read/i);
  assert.deepEqual(JSON.parse(JSON.stringify(v)), v, "plain JSON");
  assert.equal(v.rows[0].requiredKw, undefined, "no computed field goes to the screen");
});

test("rowCheckView can show what was typed, with the rows that failed marked", () => {
  const { rows, skipped } = fresh();
  const v = rowCheckView(rows, skipped, { draft: [edit("r1", { tag: "Roof 1", type: "package", value: "abc", unit: "TR", qty: "1" })], errorIds: ["r1"], errors: ["Roof 1: bad"] });
  assert.equal(v.rows[1].value, "abc");
  assert.equal(v.rows[1].bad, true);
  assert.equal(v.rows[0].bad, undefined);
  assert.deepEqual(v.errors, ["Roof 1: bad"]);
});

// ── the facade and the web adapter ─────────────────────────────────────────

test("sendRowCheck goes to the channel's rowCheck, and a channel without one cannot be asked", async () => {
  const { runWithChannel, sendRowCheck } = require("../lib/channel.js");
  const calls = [];
  const adapter = { name: "a", supports: { rowCheck: true }, rowCheck: async (...a) => { calls.push(a); return "done"; } };
  const { rows, skipped } = fresh();
  assert.equal(await runWithChannel(adapter, () => sendRowCheck("u", rows, skipped)), "done");
  assert.deepEqual(calls[0].slice(0, 3), ["u", rows, skipped]);
  await runWithChannel(adapter, () => sendRowCheck("u", rows, skipped, { errors: ["x"] }));
  assert.deepEqual(calls[1][3], { errors: ["x"] });
  await assert.rejects(runWithChannel({ name: "b", supports: {} }, () => sendRowCheck("u", rows, skipped)), /table/i);
  await assert.rejects(sendRowCheck("u", rows, skipped), /channel/i);
});

test("the web adapter saves the table as a rowcheck message and logs a text line to the CRM", async () => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const { openDb } = require("../lib/db.js");
  const { createConversations } = require("../lib/conversations.js");
  const { createWebChannel } = require("../lib/channel-web.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hvac-rowcheck-"));
  const db = openDb(":memory:");
  try {
    const conversations = createConversations({ db });
    const crmCalls = [];
    const channel = createWebChannel({ conversations, dataDir: dir, crm: { logOutbound: (to, p) => crmCalls.push([to, p]) } });
    assert.equal(typeof channel.rowCheck, "function");
    const { rows, skipped } = fresh();
    assert.equal(await channel.rowCheck("u1", rows, skipped), true);
    const [m] = conversations.since("u1", 0);
    assert.equal(m.role, "bot");
    assert.equal(m.kind, "rowcheck");
    assert.deepEqual(m.body, rowCheckView(rows, skipped));
    assert.equal(crmCalls.length, 1);
    assert.equal(crmCalls[0][1].type, "text");
    assert.match(crmCalls[0][1].text.body, /3 rows/);
    // the draft and errors a rejected table comes back with
    await channel.rowCheck("u1", rows, skipped, { errors: ["Roof 1: bad"], errorIds: ["r1"], draft: [{ id: "r1", value: "abc" }] });
    const second = conversations.since("u1", m.seq)[0];
    assert.deepEqual(second.body.errors, ["Roof 1: bad"]);
    assert.equal(second.body.rows[1].value, "abc");
    assert.equal(second.body.rows[1].bad, true);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── the flow, through the real server.js ───────────────────────────────────

const { createHarness, fixturesExist } = require("./replay/harness.js");
const skip = !fixturesExist() && "replay fixtures not found (run tests/replay/export-log.js)";
const USER = "100000001";
const DAY = 24 * 60 * 60 * 1000;

const textMsg = (body) => ({ type: "text", text: { body } });
const tapMsg = (id, title = "Tap", data) => ({ type: "interactive", interactive: { type: "button_reply", button_reply: { id, title, ...(data !== undefined ? { data } : {}) } } });
const imageMsg = () => ({ type: "image", image: { id: "up1", mime_type: "image/jpeg" } });

// A chat where each scripted message runs through deliverMessage. `web` gives the
// adapter the schedule table; without it the adapter is like WhatsApp's.
function setup({ web = true, readerRows = null } = {}) {
  const sent = [];
  const files = [];
  const checks = [];
  const script = [];
  const adapter = {
    name: web ? "web" : "whatsapp", supports: web ? { rowCheck: true } : {},
    typing: async () => {},
    downloadMedia: async () => ({ buffer: Buffer.from("fake image"), mediaType: "image/jpeg" }),
    text: async (to, body) => { sent.push({ kind: "text", body }); return true; },
    longText: async (to, body) => { sent.push({ kind: "text", body }); return true; },
    buttons: async (to, text, buttons) => { sent.push({ kind: "buttons", body: text, buttons }); return true; },
    list: async (to, text, label, rows) => { sent.push({ kind: "list", body: text, rows }); return true; },
    driveFile: async () => true, pageHits: async () => true,
    generatedFile: async (to, buffer, filename, caption) => { files.push({ filename, caption, size: buffer.length, head: buffer.subarray(0, 4).toString() }); sent.push({ kind: "file", filename }); return true; },
  };
  if (web) adapter.rowCheck = async (to, rows, skipped, opts) => { const view = rowCheckView(rows, skipped, opts); checks.push({ tableId: view.tableId, rows: view.rows, skipped: view.skipped, opts: opts ? clone(opts) : null }); sent.push({ kind: "rowcheck" }); return true; };
  const h = createHarness(async (value, message) => {
    const { deliverMessage } = require("../server.js");
    await deliverMessage(value, { from: message.from, id: message.id, timestamp: message.timestamp, ...script.shift() }, adapter);
  });
  if (readerRows) {
    const schedule = require("../schedule-select.js");
    schedule.rowsFromScheduleImage = async () => {
      const norm = schedule.normalizeRows(readerRows);
      // the reader also reports rows it could not read
      return { ...norm, skipped: [...norm.skipped, { location: "Store", raw: "smudged" }], scheduleCondition: schedule.summarize(norm.rows).scheduleCondition };
    };
  }
  return {
    sent, files, checks, h,
    async say(message) { script.push(message); await h.send(USER, "x"); },
    store: () => require("../lib/session-store.js"),
    last: () => sent[sent.length - 1],
    texts: () => sent.filter((s) => s.kind === "text").map((s) => s.body),
    done() { try { require("../lib/db.js").closeDb(); } catch (_) { /* never opened */ } h.close(); },
  };
}

// the PDF report button: one chip, its id carries which result it belongs to
function assertPrintButton(msg) {
  assert.equal(msg.kind, "buttons");
  assert.equal(msg.buttons.length, 1);
  assert.equal(msg.buttons[0].title, "PDF report");
  assert.match(msg.buttons[0].id, /^print\|\d+$/);
  return msg.buttons[0].id;
}

// the table as the screen would send it back, with some fields changed
const echo = (check, changes = {}) => [
  ...check.rows.map((r) => ({ ...r, ...(changes[r.id] || {}) })),
  ...check.skipped.map((s) => ({ id: s.id, tag: s.tag, type: "", value: "", unit: "", qty: "", ...(changes[s.id] || {}) })),
];

async function readSchedule(t) {
  await t.say(textMsg("Schedule Selection"));
  await t.say(imageMsg());
}

test("on a channel with the table, reading a schedule shows it and waits for Looks right", { skip }, async () => {
  const t = setup();
  try {
    await readSchedule(t);
    assert.equal(t.checks.length, 1);
    assert.equal(t.checks[0].rows.length, 2);
    assert.deepEqual(t.checks[0].rows[0], { id: "r0", tag: "Room 1", type: "split", value: 24000, unit: "BTU/h", qty: 2 });
    assert.equal(t.last().kind, "rowcheck", "no question yet: the person is checking the rows");
    assert.equal(t.store().getFlow(USER).data.step, "awaitRowCheck");
    assert.ok(t.texts().every((x) => !/Rate capacities/.test(x)));
  } finally { t.done(); }
});

test("typing while the table is open gets a reminder, and cancel and menu still work", { skip }, async () => {
  const t = setup();
  try {
    await readSchedule(t);
    await t.say(textMsg("is it ok?"));
    assert.match(t.last().body, /table/i);
    assert.match(t.last().body, /Looks right/);
    assert.equal(t.store().getFlow(USER).data.step, "awaitRowCheck");
    assert.equal(t.checks.length, 1, "the table is not sent again");
    await t.say(textMsg("cancel"));
    assert.match(t.last().body, /Cancelled/);
    assert.equal(t.store().getFlow(USER), null);

    await readSchedule(t);
    await t.say(textMsg("menu"));
    assert.equal(t.last().kind, "list");
    assert.equal(t.store().getFlow(USER), null);
  } finally { t.done(); }
});

test("Looks right with nothing changed carries on with the usual questions", { skip }, async () => {
  const t = setup();
  try {
    await readSchedule(t);
    await t.say(tapMsg("rows-ok", "Looks right", { tableId: t.checks.at(-1).tableId, rows: echo(t.checks[0]) }));
    assert.match(t.last().body, /Rate capacities at/);
    assert.match(t.texts().join("\n"), /\*2\* rows confirmed/);
    await t.say(textMsg("2"));            // T3
    assert.match(t.last().body, /Which split brand/);
    await t.say(textMsg("1"));            // Toshiba
    assert.match(t.last().body, /Package line/);
    await t.say(textMsg("2"));            // Trane
    const result = t.texts().find((x) => /Schedule Selection\* — 2 rows/.test(x));
    assert.ok(result, "results for both rows");
    assert.match(result, /Room 1.*×2/);
  } finally { t.done(); }
});

test("a detected rating skips its question after the check", { skip }, async () => {
  const t = setup({ readerRows: [
    { location: "Room 1", type: "SPLIT", category: "split", capacity: 24000, unit: "BTU/HR", qty: 2, condition: "T3" },
  ] });
  try {
    await readSchedule(t);
    await t.say(tapMsg("rows-ok", "Looks right", { tableId: t.checks.at(-1).tableId, rows: echo(t.checks[0]) }));
    assert.match(t.texts().join("\n"), /Detected rating \*T3 \(46°C\)\*/);
    assert.match(t.last().body, /Which split brand/);
  } finally { t.done(); }
});

test("corrections reach the results, and a fixed skipped row is selected like any other", { skip }, async () => {
  const t = setup({ readerRows: [
    { location: "Room 1", type: "SPLIT", category: "split", capacity: 24000, unit: "BTU/HR", qty: 2 },
    { location: "Roof 1", type: "PACKAGE AC", category: "package", capacity: 10, unit: "TR", qty: 1 },
  ] });
  try {
    await readSchedule(t);
    assert.equal(t.checks[0].skipped.length, 1);
    await t.say(tapMsg("rows-ok", "Looks right", { tableId: t.checks.at(-1).tableId, rows: echo(t.checks[0], {
      r0: { qty: 5, value: 36000 },
      s0: { type: "split", value: 2, unit: "TR", qty: 3 },
    }) }));
    const flow = t.store().getFlow(USER).data;
    assert.equal(flow.rows.length, 3);
    assert.equal(flow.skipped.length, 0);
    assert.equal(flow.rows[0].qty, 5);
    assert.equal(flow.rows[0].srcValue, 36000);
    assert.ok(Math.abs(flow.rows[0].requiredKw - 10.55) < 0.05, "36000 BTU/h is 10.55 kW, worked out by the engine's converter");
    assert.equal(flow.rows[2].location, "Store");
    assert.ok(Math.abs(flow.rows[2].requiredKw - 7.03) < 0.05);
    await t.say(textMsg("2"));
    await t.say(textMsg("1"));
    await t.say(textMsg("2"));
    const result = t.texts().find((x) => /Schedule Selection\* — 3 rows/.test(x));
    assert.ok(result);
    assert.match(result, /Room 1.*×5/);
    assert.match(result, /Store.*×3/);
    assert.doesNotMatch(result, /Rows to verify/);
  } finally { t.done(); }
});

test("a bad correction names the row, changes nothing and shows the table again with the typing kept", { skip }, async () => {
  const t = setup();
  try {
    await readSchedule(t);
    const before = clone(t.store().getFlow(USER).data.rows);
    await t.say(tapMsg("rows-ok", "Looks right", { tableId: t.checks.at(-1).tableId, rows: echo(t.checks[0], { r0: { qty: 5 }, r1: { value: "ten" } }) }));
    assert.equal(t.checks.length, 2, "the table comes back");
    assert.deepEqual(t.checks[1].opts.errorIds, ["r1"]);
    assert.match(t.checks[1].opts.errors[0], /Roof 1/);
    assert.equal(t.checks[1].opts.draft.find((d) => d.id === "r1").value, "ten");
    assert.match(t.texts().join("\n"), /Roof 1/);
    const flow = t.store().getFlow(USER).data;
    assert.equal(flow.step, "awaitRowCheck");
    assert.deepEqual(flow.rows, before, "not even the good edit was applied");
    // fixing it goes through
    await t.say(tapMsg("rows-ok", "Looks right", { tableId: t.checks.at(-1).tableId, rows: echo(t.checks[0], { r0: { qty: 5 }, r1: { value: 12 } }) }));
    assert.equal(t.store().getFlow(USER).data.rows[1].srcValue, 12);
  } finally { t.done(); }
});

test("a table with no usable data, or a stale one, is refused politely", { skip }, async () => {
  const t = setup();
  try {
    await readSchedule(t);
    await t.say(tapMsg("rows-ok", "Looks right"));
    assert.match(t.last().body, /out of date/, "a tap that does not say which table it is for is refused");
    assert.equal(t.store().getFlow(USER).data.step, "awaitRowCheck");
    assert.equal(t.checks.length, 1);
    const id = t.checks[0].tableId;
    await t.say(tapMsg("rows-ok", "Looks right", { tableId: id, rows: [{ id: "r77", qty: 2 }] }));
    assert.match(t.texts().join("\n"), /out of date/);
    assert.equal(t.store().getFlow(USER).data.step, "awaitRowCheck");
    await t.say(tapMsg("rows-ok", "Looks right", { tableId: id }));      // the right table, nothing in it
    assert.equal(t.checks.length, 3, "the table comes back (it had already come back once for the unknown row)");
    assert.equal(t.store().getFlow(USER).data.step, "awaitRowCheck");
  } finally { t.done(); }
});

test("a second Looks right after the flow moved on gets a harmless reply", { skip }, async () => {
  const t = setup();
  try {
    await t.say(tapMsg("rows-ok", "Looks right", { tableId: "abc", rows: [] }));     // never started
    assert.match(t.last().body, /no longer open/i);
    await readSchedule(t);
    const rows = { tableId: t.checks[0].tableId, rows: echo(t.checks[0]) };
    await t.say(tapMsg("rows-ok", "Looks right", rows));
    const step = t.store().getFlow(USER).data.step;
    const count = t.sent.length;
    await t.say(tapMsg("rows-ok", "Looks right", rows));
    assert.equal(t.sent.length, count + 1, "one reply, nothing else");
    assert.match(t.last().body, /no longer open/i);
    assert.equal(t.store().getFlow(USER).data.step, step, "the flow did not move");
    await t.say(textMsg("cancel"));
    await t.say(tapMsg("rows-ok", "Looks right", rows));
    assert.match(t.last().body, /no longer open/i);
  } finally { t.done(); }
});

test("without the table (WhatsApp) the flow is exactly as before", { skip }, async () => {
  const t = setup({ web: false });
  try {
    await readSchedule(t);
    assert.equal(t.checks.length, 0);
    assert.match(t.texts().join("\n"), /I read \*2\* rows/);
    assert.match(t.last().body, /Rate capacities at/);
    assert.equal(t.store().getFlow(USER).data.step, "awaitCondition");
    // and a Looks right tap has nothing to do there
    await t.say(tapMsg("rows-ok", "Looks right", { rows: [] }));
    assert.match(t.last().body, /no longer open/i);
  } finally { t.done(); }
});

// ── results: the PDF button, one path for the tap and the word, 30 days ─────

async function scheduleToResult(t) {
  await readSchedule(t);
  await t.say(tapMsg("rows-ok", "Looks right", { tableId: t.checks.at(-1).tableId, rows: echo(t.checks.at(-1)) }));
  await t.say(textMsg("2"));
  await t.say(textMsg("1"));
  await t.say(textMsg("2"));
}

test("schedule results end with a PDF report button whose id is print", { skip }, async () => {
  const t = setup();
  try {
    await scheduleToResult(t);
    assert.equal(t.last().kind, "buttons");
    assertPrintButton(t.last());
  } finally { t.done(); }
});

test("split results end with the same button", { skip }, async () => {
  const t = setup();
  try {
    await t.say(textMsg("Split Selection"));
    await t.say(textMsg("1"));
    await t.say(textMsg("T3"));
    await t.say(textMsg("5 kw\n2 ton"));
    assertPrintButton(t.last());
    await t.say(tapMsg("print", "PDF report"));
    assert.equal(t.files.at(-1).filename, "Split_Selection_Toshiba.pdf");
  } finally { t.done(); }
});

test("the print tap gives the same report as typing print", { skip }, async () => {
  const t = setup();
  try {
    await scheduleToResult(t);
    await t.say(tapMsg("print", "PDF report"));
    const tapped = t.files.splice(0);
    assert.ok(tapped.length >= 2, "the report and the package datasheet");
    assert.equal(tapped[0].filename, "Schedule_Selection.pdf");
    assert.equal(tapped[0].head, "%PDF");
    await t.say(textMsg("print"));
    const typed = t.files.splice(0);
    assert.deepEqual(typed, tapped);
  } finally { t.done(); }
});

test("a print tap with nothing to print says so", { skip }, async () => {
  const t = setup();
  try {
    await t.say(tapMsg("print", "PDF report"));
    assert.match(t.last().body, /No recent results/);
    assert.equal(t.files.length, 0);
  } finally { t.done(); }
});

test("the newest result is the one printed, whichever kind it is", { skip }, async () => {
  const t = setup();
  try {
    await scheduleToResult(t);
    await t.say(textMsg("Split Selection"));
    await t.say(textMsg("1"));
    await t.say(textMsg("T3"));
    await t.say(textMsg("5 kw"));
    await t.say(tapMsg("print", "PDF report"));
    assert.equal(t.files.at(-1).filename, "Split_Selection_Toshiba.pdf");
    t.files.length = 0;
    await scheduleToResult(t);
    await t.say(tapMsg("print", "PDF report"));
    assert.equal(t.files[0].filename, "Schedule_Selection.pdf", "not the older split report");
  } finally { t.done(); }
});

test("split and schedule results stay available for 30 days", { skip }, async () => {
  const t = setup();
  try {
    const start = Date.parse("2026-03-01T09:00:00Z");
    t.h.setTime(start);
    await t.say(textMsg("Split Selection"));
    await t.say(textMsg("1"));
    await t.say(textMsg("T3"));
    await t.say(textMsg("5 kw"));
    t.h.setTime(start + 29 * DAY);
    await t.say(tapMsg("print"));
    assert.equal(t.files.at(-1).filename, "Split_Selection_Toshiba.pdf");
    t.h.setTime(start + 31 * DAY);
    await t.say(tapMsg("print"));
    assert.match(t.last().body, /No recent results/);

    t.files.length = 0;
    t.h.setTime(start + 40 * DAY);
    await scheduleToResult(t);
    t.h.setTime(start + 40 * DAY + 29 * DAY);
    await t.say(tapMsg("print"));
    assert.equal(t.files[0].filename, "Schedule_Selection.pdf");
    t.h.setTime(start + 40 * DAY + 31 * DAY);
    await t.say(tapMsg("print"));
    assert.match(t.last().body, /No recent results/);
  } finally { t.done(); }
});

test("results are plain JSON and small, are saved with the person's state, and print works after a restart", { skip }, async () => {
  const t = setup();
  try {
    await scheduleToResult(t);
    const store = t.store();
    const sched = store.getCtx(USER, "scheduleResult");
    assert.deepEqual(JSON.parse(JSON.stringify(sched)), sched);
    await t.say(textMsg("Split Selection"));
    await t.say(textMsg("1"));
    await t.say(textMsg("T3"));
    await t.say(textMsg("5 kw\n3 kw\n8 ton"));
    const split = store.getCtx(USER, "splitResult");
    assert.ok(split.units.length === 3);
    assert.ok(split.units.every((u) => u.ranked === undefined), "the model ranking behind each line is not kept");
    assert.ok(JSON.stringify(split).length < 3000, `split state is ${JSON.stringify(split).length} bytes`);

    // what the database holds for them, restored into a store that is empty
    store.clearAll(USER);
    assert.equal(store.getCtx(USER, "splitResult"), null);
    store.restore();
    assert.ok(store.getCtx(USER, "splitResult"));
    await t.say(tapMsg("print", "PDF report"));
    assert.equal(t.files.at(-1).filename, "Split_Selection_Toshiba.pdf");
    assert.equal(t.files.at(-1).head, "%PDF");
    assert.deepEqual(Object.keys(store.getCtx(USER, "splitResult")), ["brand", "units", "at"], "no PDF bytes kept in the state");
  } finally { t.done(); }
});

test("a schedule result restored after a restart still prints the report and the datasheets", { skip }, async () => {
  const t = setup();
  try {
    await scheduleToResult(t);
    const store = t.store();
    store.clearAll(USER);
    store.restore();
    await t.say(tapMsg("print", "PDF report"));
    assert.deepEqual(t.files.map((f) => f.filename), ["Schedule_Selection.pdf", "MTZ_Selection_Roof 1.pdf"]);
    assert.ok(t.files.every((f) => f.head === "%PDF"));
  } finally { t.done(); }
});

test("on WhatsApp the schedule table is not offered and the results get the button", { skip }, async () => {
  const t = setup({ web: false });
  try {
    await readSchedule(t);
    await t.say(textMsg("2"));
    await t.say(textMsg("1"));
    await t.say(textMsg("2"));
    assertPrintButton(t.last());
  } finally { t.done(); }
});

// ── fix round: table identity, removing rows, which result a button prints ──

test("the table carries an id that follows its rows", () => {
  const { rows, skipped } = fresh();
  const a = rowCheckView(rows, skipped);
  assert.match(a.tableId, /^[0-9a-f]{12}$/);
  assert.equal(rowCheckView(clone(rows), clone(skipped)).tableId, a.tableId, "same rows, same id");
  assert.equal(rowCheckView(rows, skipped, { errors: ["x"], draft: [{ id: "r0", qty: "9" }] }).tableId, a.tableId, "a table sent back after an error keeps its id");
  const other = applyRowEdits(rows, skipped, [edit("r0", { qty: 7 })]);
  assert.notEqual(rowCheckView(other.rows, other.skipped).tableId, a.tableId);
  assert.notEqual(rowCheckView(rows, skipped.slice(1)).tableId, a.tableId);
});

test("a row can be removed, and so can a skipped row", () => {
  const { rows, skipped } = fresh();
  const out = applyRowEdits(rows, skipped, [edit("r1", { remove: true }), edit("s0", { remove: true })]);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.rows.map((r) => r.location), ["Room 1", "Hall"]);
  assert.deepEqual(out.skipped.map((s) => s.location), ["Lobby"]);
  assert.deepEqual(out.rows[0], rows[0]);
});

test("a removed row is not looked at, and only remove: true removes", () => {
  const { rows, skipped } = fresh();
  const out = applyRowEdits(rows, skipped, [edit("r1", { remove: true, qty: "nonsense", value: "x", unit: "psi" }), edit("s1", { remove: true, type: "split" })]);
  assert.deepEqual(out.errors, []);
  assert.equal(out.rows.length, 2);
  assert.equal(out.skipped.length, 1);
  for (const remove of ["true", 1, "yes", {}, null, false]) {
    const kept = applyRowEdits(rows, skipped, [edit("r1", { remove })]);
    assert.deepEqual(kept.errors, [], String(remove));
    assert.equal(kept.rows.length, 3, `remove ${JSON.stringify(remove)} removes nothing`);
  }
});

test("a table with nothing left is refused with a clear message and changes nothing", () => {
  const { rows, skipped } = fresh();
  const all = rows.map((_, i) => edit(`r${i}`, { remove: true }));
  const out = applyRowEdits(rows, skipped, all);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /No rows would be left/);
  assert.deepEqual(out.rows, rows);
  assert.deepEqual(out.skipped, skipped);
  // a skipped row fixed in the same table is a row, so it is enough
  const kept = applyRowEdits(rows, skipped, [...all, edit("s0", { type: "split", value: 5, unit: "kW" })]);
  assert.deepEqual(kept.errors, []);
  assert.deepEqual(kept.rows.map((r) => r.location), ["Store"]);
});

test("an error elsewhere still stops a removal", () => {
  const { rows, skipped } = fresh();
  const out = applyRowEdits(rows, skipped, [edit("r0", { remove: true }), edit("r1", { qty: 0 })]);
  assert.equal(out.errors.length, 1);
  assert.deepEqual(out.rows, rows);
});

test("a table sent back shows the rows that were marked for removal", () => {
  const { rows, skipped } = fresh();
  const v = rowCheckView(rows, skipped, { draft: [edit("r1", { remove: true }), edit("s0", { remove: true }), edit("r0", { remove: false })] });
  assert.equal(v.rows[1].remove, true);
  assert.equal(v.rows[0].remove, undefined);
  assert.equal(v.skipped[0].remove, true);
  assert.equal(v.skipped[1].remove, undefined);
});

test("a tap from an older table does not touch the schedule being checked", { skip }, async () => {
  const schedule = () => require("../schedule-select.js");
  const t = setup();
  try {
    await readSchedule(t);                       // table A: Room 1, Roof 1
    const a = { tableId: t.checks[0].tableId, rows: echo(t.checks[0], { r0: { qty: 9, value: 1 }, r1: { qty: 8 } }) };
    await t.say(textMsg("cancel"));
    const real = schedule().rowsFromScheduleImage;
    schedule().rowsFromScheduleImage = async () => {
      const norm = schedule().normalizeRows([
        { location: "Plant room", type: "SPLIT", category: "split", capacity: 5, unit: "kW", qty: 1 },
        { location: "Lab", type: "DUCTED", category: "ducted", capacity: 3, unit: "TR", qty: 2 },
      ]);
      return { ...norm, scheduleCondition: null };
    };
    await readSchedule(t);                       // table B, same number of rows
    const b = t.checks.at(-1);
    assert.notEqual(b.tableId, a.tableId);
    const before = clone(t.store().getFlow(USER).data.rows);
    await t.say(tapMsg("rows-ok", "Looks right", a));
    assert.match(t.last().body, /out of date/);
    const flow = t.store().getFlow(USER).data;
    assert.equal(flow.step, "awaitRowCheck");
    assert.deepEqual(flow.rows, before, "B's tags, loads, units and quantities are as they were read");
    assert.equal(t.checks.length, 2, "no third table");
    // B's own table goes through
    await t.say(tapMsg("rows-ok", "Looks right", { tableId: b.tableId, rows: echo(b, { r1: { qty: 4 } }) }));
    assert.equal(t.store().getFlow(USER).data.rows[1].qty, 4);
    assert.equal(t.store().getFlow(USER).data.rows[0].location, "Plant room");
    schedule().rowsFromScheduleImage = real;
  } finally { t.done(); }
});

test("removing rows on the screen takes them out of the selection and the report", { skip }, async () => {
  const t = setup({ readerRows: [
    { location: "Room 1", type: "SPLIT", category: "split", capacity: 24000, unit: "BTU/HR", qty: 2 },
    { location: "Phantom", type: "SPLIT", category: "split", capacity: 5, unit: "kW", qty: 1 },
    { location: "Roof 1", type: "PACKAGE AC", category: "package", capacity: 10, unit: "TR", qty: 1 },
  ] });
  try {
    await readSchedule(t);
    const check = t.checks.at(-1);
    await t.say(tapMsg("rows-ok", "Looks right", { tableId: check.tableId, rows: echo(check, { r1: { remove: true }, s0: { remove: true } }) }));
    const flow = t.store().getFlow(USER).data;
    assert.deepEqual(flow.rows.map((r) => r.location), ["Room 1", "Roof 1"]);
    assert.equal(flow.skipped.length, 0);
    await t.say(textMsg("2"));
    await t.say(textMsg("1"));
    await t.say(textMsg("2"));
    const result = t.texts().find((x) => /Schedule Selection\* — 2 rows/.test(x));
    assert.ok(result);
    assert.doesNotMatch(result, /Phantom/);
    assert.doesNotMatch(result, /Rows to verify/);
    const stored = t.store().getCtx(USER, "scheduleResult");
    assert.deepEqual(stored.rows.map((r) => r.location), ["Room 1", "Roof 1"]);
    assert.deepEqual(stored.skipped, []);
  } finally { t.done(); }
});

test("removing every row is refused, the table comes back with the removals kept", { skip }, async () => {
  const t = setup();
  try {
    await readSchedule(t);
    const check = t.checks.at(-1);
    const all = { r0: { remove: true }, r1: { remove: true } };
    await t.say(tapMsg("rows-ok", "Looks right", { tableId: check.tableId, rows: echo(check, all) }));
    assert.match(t.texts().join("\n"), /No rows would be left/);
    assert.equal(t.checks.length, 2);
    assert.equal(t.checks[1].tableId, check.tableId);
    assert.equal(t.store().getFlow(USER).data.rows.length, 2);
    assert.equal(t.store().getFlow(USER).data.step, "awaitRowCheck");
  } finally { t.done(); }
});

test("a PDF report button prints the result it sits under, not a newer one", { skip }, async () => {
  const t = setup();
  try {
    await scheduleToResult(t);
    const first = assertPrintButton(t.last());
    await scheduleToResult(t);
    const second = assertPrintButton(t.last());
    assert.notEqual(first, second);
    const filesBefore = t.files.length;
    await t.say(tapMsg(first, "PDF report"));
    assert.match(t.last().body, /That result was replaced; tap the newest, or type print/);
    assert.equal(t.files.length, filesBefore, "no report from the older button");
    await t.say(tapMsg(second, "PDF report"));
    assert.equal(t.files[filesBefore].filename, "Schedule_Selection.pdf");
    // a bare print (an old chip, or the word) still prints the newest
    t.files.length = 0;
    await t.say(tapMsg("print", "PDF report"));
    assert.equal(t.files[0].filename, "Schedule_Selection.pdf");
    t.files.length = 0;
    await t.say(textMsg("print"));
    assert.equal(t.files[0].filename, "Schedule_Selection.pdf");
  } finally { t.done(); }
});

test("each kind of result has its own button, and the older one is refused after the newer arrives", { skip }, async () => {
  const t = setup();
  try {
    await scheduleToResult(t);
    const sched = assertPrintButton(t.last());
    await t.say(textMsg("Split Selection"));
    await t.say(textMsg("1"));
    await t.say(textMsg("T3"));
    await t.say(textMsg("5 kw"));
    const split = assertPrintButton(t.last());
    assert.equal(split, `print|${t.store().getCtx(USER, "splitResult").at}`);
    t.files.length = 0;
    await t.say(tapMsg(sched, "PDF report"));
    assert.equal(t.files[0].filename, "Schedule_Selection.pdf", "the schedule button still prints the schedule: it is still saved");
    t.files.length = 0;
    await t.say(tapMsg(split, "PDF report"));
    assert.equal(t.files[0].filename, "Split_Selection_Toshiba.pdf");
  } finally { t.done(); }
});

test("the generating message says when the results were saved, and an expired button says there is nothing", { skip }, async () => {
  const t = setup();
  try {
    const start = Date.parse("2026-03-14T06:12:00Z");           // 09:12 in Qatar
    t.h.setTime(start);
    await scheduleToResult(t);
    const id = assertPrintButton(t.last());
    t.h.setTime(start + 3 * DAY);
    await t.say(tapMsg(id, "PDF report"));
    assert.match(t.texts().find((x) => /Generating PDF report/.test(x)), /Generating PDF report… \(results from 14 Mar, 09:12\)/);
    t.h.setTime(start + 31 * DAY);
    await t.say(tapMsg(id, "PDF report"));
    assert.match(t.last().body, /No recent results/);
  } finally { t.done(); }
});

test("saying menu or hi does not throw away saved results", { skip }, async () => {
  const t = setup();
  try {
    await scheduleToResult(t);
    await t.say(textMsg("menu"));
    assert.equal(t.last().kind, "list");
    await t.say(textMsg("hi"));
    assert.ok(t.store().getCtx(USER, "scheduleResult"), "still saved");
    t.files.length = 0;
    await t.say(tapMsg("print", "PDF report"));
    assert.equal(t.files[0].filename, "Schedule_Selection.pdf");
    // a split result too, and the menu still clears the flow and the open list
    await t.say(textMsg("Split Selection"));
    await t.say(textMsg("menu"));
    assert.equal(t.store().getFlow(USER), null);
    assert.ok(t.store().getCtx(USER, "menu"), "the menu just shown is open");
  } finally { t.done(); }
});

test("the session store can keep named results when everything else is cleared", () => {
  const { createSessionStore } = require("../lib/session-store.js");
  const s = createSessionStore();
  s.startFlow("u", "split", {});
  s.setCtx("u", "menu", 1); s.setCtx("u", "list", 2); s.setCtx("u", "splitResult", 3); s.setCtx("u", "scheduleResult", 4);
  s.clearAll("u", ["splitResult", "scheduleResult"]);
  assert.equal(s.getFlow("u"), null);
  assert.equal(s.getCtx("u", "menu"), null);
  assert.equal(s.getCtx("u", "list"), null);
  assert.equal(s.getCtx("u", "splitResult"), 3);
  assert.equal(s.getCtx("u", "scheduleResult"), 4);
  s.clearAll("u");
  assert.equal(s.getCtx("u", "splitResult"), null);
});
