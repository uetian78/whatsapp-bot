// ============================================================
//  Per-key task serialization. Messages from the same user are
//  handled strictly in arrival order so a double-text can't
//  interleave inside a flow's state machine. Different users
//  remain fully concurrent.
// ============================================================
const tails = new Map(); // key -> tail promise of that user's chain

function enqueue(key, fn) {
  const prev = tails.get(key) || Promise.resolve();
  const run = prev.then(fn, fn); // run next regardless of the previous outcome
  // The stored tail swallows rejection so the chain never becomes a
  // permanently-rejected promise; callers still see `run`'s real result.
  const tail = run.catch(() => {});
  tails.set(key, tail);
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}

module.exports = { enqueue };
