const test = require("node:test");
const assert = require("node:assert");
const { enqueue } = require("../lib/user-queue.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("same key runs in order even when the first call is slow", async () => {
  const order = [];
  const p1 = enqueue("u1", async () => { await sleep(30); order.push("a"); });
  const p2 = enqueue("u1", async () => { order.push("b"); });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["a", "b"]);
});

test("different keys run concurrently", async () => {
  const order = [];
  const p1 = enqueue("u2", async () => { await sleep(30); order.push("slow"); });
  const p2 = enqueue("u3", async () => { order.push("fast"); });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["fast", "slow"]);
});

test("an error in one task does not block the next", async () => {
  const order = [];
  const p1 = enqueue("u4", async () => { throw new Error("boom"); });
  const p2 = enqueue("u4", async () => { order.push("after"); });
  await assert.rejects(p1);
  await p2;
  assert.deepEqual(order, ["after"]);
});
