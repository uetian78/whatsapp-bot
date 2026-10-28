const test = require("node:test");
const assert = require("node:assert");
const { createNumberHealth, metaEventLines, CHECK_EVERY_MS, REGISTER_GAP_MS } = require("../lib/number-health.js");

const HOUR = 60 * 60 * 1000;

// A health checker over fakes: `status` is what Meta reports, `registered`
// collects the PINs passed to /register, `logs` collects log lines.
function setup({ status = "CONNECTED", pin = "123456", registerError = null, statusError = null } = {}) {
  const clock = { t: 1_000_000 };
  const calls = { status: 0, registered: [], logs: [] };
  const health = createNumberHealth({
    getStatus: async () => {
      calls.status++;
      if (statusError) throw new Error(statusError);
      return typeof status === "function" ? status() : status;
    },
    register: async (p) => {
      if (registerError) throw new Error(registerError);
      calls.registered.push(p);
    },
    pin,
    now: () => clock.t,
    log: (line) => calls.logs.push(line),
  });
  return { health, clock, calls };
}

test("CONNECTED number is left alone", async () => {
  const { health, calls } = setup({ status: "CONNECTED" });
  const r = await health.check();
  assert.equal(r.status, "CONNECTED");
  assert.deepEqual(calls.registered, []);
});

test("PENDING number is re-registered with the PIN", async () => {
  const { health, calls } = setup({ status: "PENDING", pin: "654321" });
  const r = await health.check();
  assert.equal(r.registered, true);
  assert.deepEqual(calls.registered, ["654321"]);
  assert.ok(calls.logs.some((l) => l.includes("PENDING") && l.includes("re-registered")));
});

test("DISCONNECTED number is re-registered too", async () => {
  const { health, calls } = setup({ status: "DISCONNECTED" });
  await health.check();
  assert.equal(calls.registered.length, 1);
});

test("without a PIN it only logs what to do", async () => {
  const { health, calls } = setup({ status: "PENDING", pin: null });
  const r = await health.check();
  assert.equal(r.registered, undefined);
  assert.deepEqual(calls.registered, []);
  assert.ok(calls.logs.some((l) => l.includes("WHATSAPP_REGISTER_PIN")));
});

test("a PIN that isn't 6 digits counts as no PIN", async () => {
  const { health, calls } = setup({ status: "PENDING", pin: "12345" });
  await health.check();
  assert.deepEqual(calls.registered, []);
  assert.ok(calls.logs.some((l) => l.includes("WHATSAPP_REGISTER_PIN")));
});

test("BANNED / FLAGGED numbers are not re-registered", async () => {
  for (const status of ["BANNED", "FLAGGED", "RESTRICTED"]) {
    const { health, calls } = setup({ status });
    await health.check();
    assert.deepEqual(calls.registered, [], status);
    assert.ok(calls.logs.some((l) => l.includes(status)), status);
  }
});

test("re-register attempts are spaced REGISTER_GAP_MS apart (Meta allows 10 per 72 h)", async () => {
  const { health, clock, calls } = setup({ status: "PENDING", registerError: "(#133005) Two step verification PIN Mismatch" });
  await health.check();
  clock.t += HOUR;
  await health.check();
  assert.equal(calls.status, 2);
  assert.equal(calls.logs.filter((l) => l.includes("re-register failed")).length, 1);
  clock.t += REGISTER_GAP_MS;
  await health.check();
  assert.equal(calls.logs.filter((l) => l.includes("re-register failed")).length, 2);
  assert.ok(REGISTER_GAP_MS * 10 > 72 * HOUR, "gap must keep a stuck number under 10 attempts per 72 h");
});

test("a failed /register is logged with Meta's message and does not throw", async () => {
  const { health, calls } = setup({ status: "PENDING", registerError: "(#133005) Two step verification PIN Mismatch" });
  const r = await health.check();
  assert.equal(r.registered, false);
  assert.ok(calls.logs.some((l) => l.includes("PIN Mismatch")));
});

test("a failed status lookup is logged and never registers", async () => {
  const { health, calls } = setup({ statusError: "socket hang up" });
  const r = await health.check();
  assert.equal(r.status, null);
  assert.deepEqual(calls.registered, []);
  assert.ok(calls.logs.some((l) => l.includes("socket hang up")));
});

test("maybeCheck runs at most once per CHECK_EVERY_MS", async () => {
  const { health, clock, calls } = setup();
  await health.maybeCheck();
  await health.maybeCheck();
  clock.t += CHECK_EVERY_MS - 1;
  await health.maybeCheck();
  assert.equal(calls.status, 1);
  clock.t += 1;
  await health.maybeCheck();
  assert.equal(calls.status, 2);
});

test("concurrent maybeCheck calls share one lookup", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { health, calls } = setup({ status: async () => { await gate; return "CONNECTED"; } });
  const a = health.maybeCheck();
  const b = health.maybeCheck();
  release();
  await Promise.all([a, b]);
  assert.equal(calls.status, 1);
});

test("metaEventLines logs non-message webhook events with their field", () => {
  const body = {
    entry: [{
      changes: [
        { field: "messages", value: { messages: [{ id: "wamid.1" }] } },
        { field: "account_update", value: { phone_number: "15556523859", event: "ACCOUNT_DELETED" } },
      ],
    }],
  };
  const lines = metaEventLines(body);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("account_update"));
  assert.ok(lines[0].includes("ACCOUNT_DELETED"));
});

test("metaEventLines tolerates empty or odd bodies", () => {
  assert.deepEqual(metaEventLines(undefined), []);
  assert.deepEqual(metaEventLines({}), []);
  assert.deepEqual(metaEventLines({ entry: [{}] }), []);
});

test("metaEventLines caps very long events", () => {
  const body = { entry: [{ changes: [{ field: "account_update", value: { blob: "x".repeat(5000) } }] }] };
  assert.ok(metaEventLines(body)[0].length < 1200);
});
