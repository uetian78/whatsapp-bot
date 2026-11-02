const test = require("node:test");
const assert = require("node:assert");
const wa = require("../lib/wa.js");
const channel = require("../lib/channel.js");
const { whatsappAdapter } = require("../lib/channel-whatsapp.js");

const {
  runWithChannel, currentChannel, showTyping,
  sendText, sendLongText, sendButtons, sendList, sendDriveFile,
} = channel;

// An adapter that records every call it gets, tagged with its own name.
function recorder(name) {
  const calls = [];
  const rec = (method) => async (...args) => { calls.push([method, ...args]); return `${name}:${method}`; };
  return {
    calls,
    adapter: {
      name,
      typing: rec("typing"),
      text: rec("text"), longText: rec("longText"), buttons: rec("buttons"), list: rec("list"),
      driveFile: rec("driveFile"),
    },
  };
}

test("sendText reaches the adapter in context", async () => {
  const r = recorder("a");
  const result = await runWithChannel(r.adapter, () => sendText("u1", "hello"));
  assert.deepEqual(r.calls, [["text", "u1", "hello"]]);
  assert.equal(result, "a:text"); // the adapter's return value comes back
});

test("every facade function maps to its adapter method", async () => {
  const r = recorder("a");
  const file = { id: "f1", name: "x.pdf" };
  const buf = Buffer.from("pdf");
  await runWithChannel(r.adapter, async () => {
    await sendLongText("u", "long");
    await sendButtons("u", "pick", [{ id: "1", title: "One" }]);
    await sendList("u", "pick", "Choose", [{ id: "1", title: "One" }]);
    await sendDriveFile("u", file);
    await showTyping("wamid.1");
  });
  assert.deepEqual(r.calls, [
    ["longText", "u", "long"],
    ["buttons", "u", "pick", [{ id: "1", title: "One" }]],
    ["list", "u", "pick", "Choose", [{ id: "1", title: "One" }]],
    ["driveFile", "u", file],
    ["typing", "wamid.1"],
  ]);
});

test("two concurrent channels never cross", async () => {
  const a = recorder("a");
  const b = recorder("b");
  const gap = () => new Promise((resolve) => setImmediate(resolve));
  const run = (r, user) => runWithChannel(r.adapter, async () => {
    await sendText(user, "1");
    await gap();
    assert.equal(currentChannel(), r.adapter);
    await sendText(user, "2");
    await gap();
    await sendButtons(user, "3", []);
  });
  await Promise.all([run(a, "ua"), run(b, "ub")]);
  assert.deepEqual(a.calls.map((c) => c[1]), ["ua", "ua", "ua"]);
  assert.deepEqual(b.calls.map((c) => c[1]), ["ub", "ub", "ub"]);
});

test("sending outside a channel throws", async () => {
  await assert.rejects(sendText("u", "x"), /channel/i);
  await assert.rejects(sendLongText("u", "x"), /channel/i);
  await assert.rejects(sendButtons("u", "x", []), /channel/i);
  await assert.rejects(sendList("u", "x", "l", []), /channel/i);
  await assert.rejects(sendDriveFile("u", { id: "1", name: "a.pdf" }), /channel/i);
  await assert.rejects(showTyping("m"), /channel/i);
});

test("currentChannel is the adapter inside, null outside", async () => {
  const r = recorder("a");
  assert.equal(currentChannel(), null);
  await runWithChannel(r.adapter, async () => assert.equal(currentChannel(), r.adapter));
  assert.equal(currentChannel(), null);
});

test("an adapter error reaches the caller", async () => {
  const r = recorder("a");
  r.adapter.text = async () => { throw new Error("boom"); };
  await assert.rejects(runWithChannel(r.adapter, () => sendText("u", "x")), /boom/);
});

// ── the WhatsApp adapter forwards to lib/wa.js and keeps what it returned ────

test("whatsappAdapter has the contract's shape", () => {
  assert.equal(whatsappAdapter.name, "whatsapp");
  for (const m of ["typing", "text", "longText", "buttons", "list", "driveFile"]) {
    assert.equal(typeof whatsappAdapter[m], "function", m);
  }
});

test("whatsappAdapter forwards each send to wa and returns its result", async (t) => {
  const file = { id: "f1", name: "x.pdf" };
  const mocks = {
    sendText: t.mock.method(wa, "sendText", async () => true),
    sendLongText: t.mock.method(wa, "sendLongText", async () => undefined),
    sendButtons: t.mock.method(wa, "sendButtons", async () => true),
    sendList: t.mock.method(wa, "sendList", async () => true),
    sendDriveFile: t.mock.method(wa, "sendDriveFile", async () => "drive-result"),
    markReadWithTyping: t.mock.method(wa, "markReadWithTyping", async () => undefined),
  };
  await runWithChannel(whatsappAdapter, async () => {
    assert.equal(await sendText("u", "hi"), true);
    await sendLongText("u", "long");
    assert.equal(await sendButtons("u", "t", [{ id: "1", title: "A" }]), true);
    assert.equal(await sendList("u", "t", "L", [{ id: "1", title: "A" }]), true);
    assert.equal(await sendDriveFile("u", file), "drive-result"); // callers rely on this
    await showTyping("wamid.1");
  });
  assert.deepEqual(mocks.sendText.mock.calls[0].arguments, ["u", "hi"]);
  assert.deepEqual(mocks.sendLongText.mock.calls[0].arguments, ["u", "long"]);
  assert.deepEqual(mocks.sendButtons.mock.calls[0].arguments, ["u", "t", [{ id: "1", title: "A" }]]);
  assert.deepEqual(mocks.sendList.mock.calls[0].arguments, ["u", "t", "L", [{ id: "1", title: "A" }]]);
  assert.deepEqual(mocks.sendDriveFile.mock.calls[0].arguments, ["u", file]);
  assert.deepEqual(mocks.markReadWithTyping.mock.calls[0].arguments, ["wamid.1"]);
});

