import assert from "node:assert/strict";
import { test } from "node:test";
import { type GrantedSession, Queue, type QueueOptions } from "../server/queue.js";

// Time is passed in explicitly and minting is injected, so the tests are
// instant and deterministic — no sleeping, no network.
// Token expiry far beyond every timestamp used in these tests.
const session: GrantedSession = {
  apiKey: "ek_test",
  expiresAt: new Date(100_000).toISOString(),
  model: "m",
  maxSessionSeconds: 1,
};

function makeQueue(overrides: Partial<QueueOptions> = {}) {
  return new Queue({
    capacity: 2,
    claimGraceMs: 100,
    sessionLeaseMs: 300,
    waitingTtlMs: 200,
    mint: async () => session,
    ...overrides,
  });
}

test("FIFO grants up to capacity, then queues with positions", async () => {
  const queue = makeQueue();
  const t0 = 1000;
  // Identical timestamps on purpose: arrival order must hold even for
  // joins landing in the same millisecond.
  const a = queue.join(t0);
  const b = queue.join(t0);
  const c = queue.join(t0);
  assert.equal(a.position, 1);
  assert.equal(c.position, 3);

  assert.equal((await queue.poll(a.ticketId, t0 + 10)).state, "ready");
  assert.equal((await queue.poll(b.ticketId, t0 + 11)).state, "ready");
  assert.deepEqual(await queue.poll(c.ticketId, t0 + 12), { state: "waiting", position: 1, queueSize: 1 });
});

test("every join takes its own spot — capacity limits sessions, not users", async () => {
  const queue = makeQueue();
  const first = queue.join(1000);
  const second = queue.join(1001);
  assert.notEqual(second.ticketId, first.ticketId);
  assert.equal(second.position, 2);
  assert.equal(queue.stats(1002).waiting, 2);
});

test("a granted slot that never starts is reclaimed after the claim grace (no-show)", async () => {
  const queue = makeQueue({ capacity: 1 });
  const t0 = 1000;
  const a = queue.join(t0);
  const b = queue.join(t0);
  assert.equal((await queue.poll(a.ticketId, t0 + 10)).state, "ready");

  // Before the grace lapses the slot is still held...
  assert.equal((await queue.poll(b.ticketId, t0 + 10 + 99)).state, "waiting");
  // ...after it, the no-show's slot goes to the next in line.
  assert.equal((await queue.poll(b.ticketId, t0 + 10 + 101)).state, "ready");
  assert.equal((await queue.poll(a.ticketId, t0 + 10 + 102)).state, "expired");
});

test("started extends the lease to the session bound — which still expires", async () => {
  const queue = makeQueue({ capacity: 1 });
  const t0 = 1000;
  const a = queue.join(t0);
  const b = queue.join(t0);
  assert.equal((await queue.poll(a.ticketId, t0)).state, "ready");
  assert.equal(queue.started(a.ticketId, t0 + 50), true);

  // Alive well past the claim grace...
  assert.equal((await queue.poll(b.ticketId, t0 + 200)).state, "waiting");
  // ...but the session bound (+50+300) reclaims it.
  assert.equal((await queue.poll(b.ticketId, t0 + 351)).state, "ready");
  assert.equal(queue.started(a.ticketId, t0 + 352), false);
});

test("release frees the slot for the next in line", async () => {
  const queue = makeQueue({ capacity: 1 });
  const t0 = 1000;
  const a = queue.join(t0);
  const b = queue.join(t0);
  assert.equal((await queue.poll(a.ticketId, t0 + 10)).state, "ready");

  queue.release(a.ticketId, false, t0 + 60);
  assert.equal((await queue.poll(b.ticketId, t0 + 61)).state, "ready");
});

test("limit_reached requeues at the head of the line, same ticket id", async () => {
  const queue = makeQueue({ capacity: 1 });
  const t0 = 1000;
  const a = queue.join(t0);
  const b = queue.join(t0);
  queue.join(t0);
  assert.equal((await queue.poll(a.ticketId, t0 + 10)).state, "ready");

  // Decart refused the connect → back to the front, ahead of b and c.
  queue.release(a.ticketId, true, t0 + 20);
  assert.deepEqual(await queue.poll(b.ticketId, t0 + 21), { state: "waiting", position: 2, queueSize: 3 });
  assert.equal((await queue.poll(a.ticketId, t0 + 22)).state, "ready");
});

test("mint failure returns the slot and keeps the user at the head", async () => {
  let failMint = true;
  const queue = makeQueue({
    capacity: 1,
    mint: async () => {
      if (failMint) throw new Error("boom");
      return session;
    },
  });
  const t0 = 1000;
  const a = queue.join(t0);

  assert.deepEqual(await queue.poll(a.ticketId, t0 + 10), { state: "waiting", position: 1, queueSize: 1 });
  failMint = false;
  assert.equal((await queue.poll(a.ticketId, t0 + 20)).state, "ready");
});

test("rejoining after the token's connect window re-mints fresh credentials", async () => {
  let minted = 0;
  const shortLived = () => ({ ...session, apiKey: `ek_${++minted}`, expiresAt: new Date(1050).toISOString() });
  const queue = makeQueue({ capacity: 1, mint: async () => shortLived() });
  const a = queue.join(1000);
  assert.equal((await queue.poll(a.ticketId, 1000)).state, "ready");
  queue.started(a.ticketId, 1000);

  // Same user comes back (app restart, second tab) after the 60s-equivalent
  // connect window — the slot is still theirs, but the old token is dead.
  const again = await queue.poll(a.ticketId, 1100);
  assert.deepEqual(again, {
    state: "ready",
    session: { ...session, apiKey: "ek_2", expiresAt: new Date(1050).toISOString() },
  });
  assert.equal(minted, 2);
});

test("waiting tickets that stop polling leave the line", async () => {
  const queue = makeQueue({ capacity: 1 });
  const t0 = 1000;
  const holder = queue.join(t0);
  assert.equal((await queue.poll(holder.ticketId, t0)).state, "ready");
  queue.started(holder.ticketId, t0); // holds the slot for the whole test
  const a = queue.join(t0);
  const b = queue.join(t0);

  // b keeps polling; a goes silent and falls out after waitingTtlMs.
  assert.equal((await queue.poll(b.ticketId, t0 + 150)).state, "waiting");
  assert.deepEqual(await queue.poll(b.ticketId, t0 + 250), { state: "waiting", position: 1, queueSize: 1 });
  assert.equal((await queue.poll(a.ticketId, t0 + 251)).state, "expired");
});

test("leaving the line while waiting removes the ticket", async () => {
  const queue = makeQueue({ capacity: 1 });
  const t0 = 1000;
  const holder = queue.join(t0);
  assert.equal((await queue.poll(holder.ticketId, t0)).state, "ready");
  const a = queue.join(t0);
  const b = queue.join(t0);

  queue.release(a.ticketId, false, t0 + 20);
  assert.deepEqual(await queue.poll(b.ticketId, t0 + 21), { state: "waiting", position: 1, queueSize: 1 });
});
