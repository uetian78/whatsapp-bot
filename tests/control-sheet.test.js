const test = require("node:test");
const assert = require("node:assert");

// Requiring the module must not read the environment or touch the network.
const { createLoadSheet, loadSheet } = require("../lib/control-sheet.js");

function fakeSheets(state) {
  return async () => {
    state.calls++;
    if (state.fail) throw new Error("Sheets is down");
    return {
      spreadsheets: {
        values: {
          batchGet: async ({ spreadsheetId, ranges }) => {
            state.seen = { spreadsheetId, ranges };
            return {
              data: {
                valueRanges: [
                  { values: state.knowledge || [["Topic", "Info"], ["", "only info"]] },
                  { values: state.allowed || [["+974 5555 1111", "Sara", "paid"], ["97455552222", "Omar"]] },
                ],
              },
            };
          },
        },
      },
    };
  };
}

function make(state = {}) {
  state.calls = 0;
  const clock = { t: 1_000_000 };
  const load = createLoadSheet({
    getSheets: fakeSheets(state), sheetId: () => "SHEET1", now: () => clock.t, cacheMs: 60_000, retryMs: 10_000, log: () => {},
  });
  return { state, clock, load };
}

test("loadSheet returns knowledge lines, the allowed numbers and the accounts", async () => {
  const { state, load } = make();
  const s = await load();
  assert.deepEqual(s.knowledge, ["Topic: Info", "only info"]);
  assert.deepEqual(s.allowed, ["97455551111", "97455552222"]);
  assert.equal(s.accounts.get("97455551111").name, "Sara");
  assert.equal(s.accounts.get("97455551111").paid, true);
  assert.deepEqual(state.seen.ranges, ["Knowledge!A2:B", "Allowed!A2:C"]);
  assert.equal(state.seen.spreadsheetId, "SHEET1");
});

test("loadSheet reads the Sheet at most once a minute", async () => {
  const { state, clock, load } = make();
  await load(); await load();
  clock.t += 59_000; await load();
  assert.equal(state.calls, 1);
  clock.t += 2_000; await load();
  assert.equal(state.calls, 2);
});

test("concurrent callers share one refresh", async () => {
  const { state, load } = make();
  await Promise.all([load(), load(), load()]);
  assert.equal(state.calls, 1);
});

test("loadSheet keeps the last good copy when a refresh fails, and throws when it has none", async () => {
  const { state, clock, load } = make({ fail: true });
  await assert.rejects(load(), /Sheets is down/);
  await assert.rejects(load(), /Sheets is down/); // no copy: every call tries again
  state.fail = false;
  const good = await load();
  assert.equal(good.accounts.size, 2);
  state.fail = true;
  clock.t += 61_000;
  const kept = await load();
  assert.equal(kept.accounts.size, 2);
  assert.deepEqual(kept.allowed, good.allowed);
  // After a failure it waits before trying again, so a dead Sheet isn't hammered.
  const calls = state.calls;
  await load();
  assert.equal(state.calls, calls);
  clock.t += 11_000;
  state.fail = false;
  state.allowed = [["97455553333", "Lina"]];
  const fresh = await load();
  assert.deepEqual(fresh.allowed, ["97455553333"]);
});

test("the exported loadSheet is a function and requiring made no call", () => {
  assert.equal(typeof loadSheet, "function");
});
