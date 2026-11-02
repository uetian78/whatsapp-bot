const test = require("node:test");
const assert = require("node:assert");

// Requiring the module must not read the environment or touch the network.
const { createLoadSheet, loadSheet } = require("../lib/control-sheet.js");

function fakeSheets(state) {
  return async () => {
    state.calls++;
    if (state.fail) throw new Error("Sheets is down");
    if (state.hang) await state.hang; // a Sheets call that doesn't come back
    return {
      spreadsheets: {
        values: {
          batchGet: async ({ spreadsheetId, ranges }) => {
            state.seen = { spreadsheetId, ranges };
            return {
              data: {
                valueRanges: [
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

function make(state = {}, extra = {}) {
  state.calls = 0;
  const clock = { t: 1_000_000 };
  const load = createLoadSheet({
    getSheets: fakeSheets(state), sheetId: () => "SHEET1", now: () => clock.t, cacheMs: 60_000, retryMs: 10_000,
    maxStaleMs: 120_000, timeoutMs: 40, log: () => {}, ...extra,
  });
  return { state, clock, load };
}

test("loadSheet returns the allowed numbers and the accounts, and reads only the Allowed tab", async () => {
  const { state, load } = make();
  const s = await load();
  assert.equal("knowledge" in s, false);
  assert.deepEqual(s.allowed, ["97455551111", "97455552222"]);
  assert.equal(s.accounts.get("97455551111").name, "Sara");
  assert.equal(s.accounts.get("97455551111").paid, true);
  assert.deepEqual(state.seen.ranges, ["Allowed!A2:C"]);
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
  await settle(); // let the failed background refresh finish
  clock.t += 11_000;
  state.fail = false;
  state.allowed = [["97455553333", "Lina"]];
  await load(); // the old copy answers at once while the refresh runs
  await settle();
  const fresh = await load();
  assert.deepEqual(fresh.allowed, ["97455553333"]);
});

const settle = () => new Promise((r) => setTimeout(r, 15));
const never = () => new Promise(() => {});

test("an old copy is served at once while one refresh runs in the background", async () => {
  const { state, clock, load } = make();
  await load();
  clock.t += 61_000;
  let release; state.hang = new Promise((r) => { release = r; });
  state.allowed = [["97455552222", "Omar"]];
  const t0 = Date.now();
  const [a, b, c] = await Promise.all([load(), load(), load()]);
  assert.ok(Date.now() - t0 < 30, "no waiting for the Sheet");
  assert.equal(a.accounts.size, 2); // the old copy
  assert.equal(b, a); assert.equal(c, a);
  assert.equal(state.calls, 2, "one background refresh, shared");
  release(); state.hang = null;
  await settle();
  assert.equal((await load()).accounts.size, 1);
  assert.equal(state.calls, 2);
});

test("a person removed from the Allowed tab loses access within about a minute", async () => {
  const { state, clock, load } = make();
  assert.ok((await load()).accounts.has("97455552222"));
  state.allowed = [["97455551111", "Sara"]]; // Omar is removed from the Sheet
  clock.t += 59_000;
  assert.ok((await load()).accounts.has("97455552222"), "still inside the minute: the cached copy");
  clock.t += 2_000; // past the minute: this request starts the refresh...
  await load();
  await settle();
  assert.equal((await load()).accounts.has("97455552222"), false, "...and the very next one is refused");
});

test("a copy older than the stale limit is waited for, so a long lull can't keep a removed person in", async () => {
  const { state, clock, load } = make();
  await load();
  state.allowed = [["97455551111", "Sara"]];
  clock.t += 121_000;
  assert.equal((await load()).accounts.has("97455552222"), false, "the first request after a lull sees the Sheet");
});

test("with no copy yet, a Sheets call that never answers fails after the timeout, and the next call can try again", async () => {
  const { state, load } = make({ hang: never() });
  const t0 = Date.now();
  await assert.rejects(load(), /did not answer/);
  assert.ok(Date.now() - t0 < 1000);
  state.hang = null;
  assert.equal((await load()).accounts.size, 2, "a hung call did not wedge the loader");
});

test("with a copy, a Sheets call that never answers is not waited for, and does not wedge later refreshes", async () => {
  const { state, clock, load } = make();
  await load();
  clock.t += 61_000;
  state.hang = never();
  const t0 = Date.now();
  assert.equal((await load()).accounts.size, 2);
  assert.ok(Date.now() - t0 < 30);
  await settle(); await settle(); await settle(); // the timeout gives up on it
  state.hang = null;
  state.allowed = [["97455553333", "Lina"]];
  clock.t += 20_000; // past the retry wait
  await load();
  await settle();
  assert.deepEqual((await load()).allowed, ["97455553333"]);
});

test("a late answer from a call that timed out is ignored", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { state, load } = make({ hang: gate });
  await assert.rejects(load(), /did not answer/);
  state.hang = null;
  const good = await load();
  release(); await settle();
  assert.equal((await load()), good);
});

test("the exported loadSheet is a function and requiring made no call", () => {
  assert.equal(typeof loadSheet, "function");
});
