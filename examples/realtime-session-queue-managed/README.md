# realtime-session-queue-managed

Client reference for **Decart's managed session queue**. When your account's
realtime concurrency is at its limit, your users wait in a fair line with
live position feedback — and with the managed queue, the *entire* integration
is this frontend. There is no backend in this example because there is
nothing for a backend to do: Decart runs the queue, watches the live session
count, and mints the short-lived connect token when it's your user's turn.

> Sibling example: [`../realtime-session-queue`](../realtime-session-queue)
> is the **self-hosted** variant of the same pattern — the reference to start
> from if you outgrow the managed queue's vocabulary and want to own queueing
> yourself.

## The whole client contract

```
App                                  Decart managed queue
 │  POST /v1/queues/{id}/tickets  (x-queue-key: <publishable>)
 ├────────────────────────────────────>│  { ticketId, position }   (or 429 queue_full)
 │  POST .../tickets/:id/poll  (every 2s)
 ├────────────────────────────────────>│  waiting → { position, queueSize }
 │             ...                     │  ready   → { session: { apiKey, model, ... } }
 │  realtime.connect(session.apiKey)   — connect within the token's expiry
 │  (session ends → Decart sees it; nothing to report back)
```

Three rules, and that's the integration:

1. **Poll every ~2s while waiting**; stop polling (or `DELETE` the ticket) to
   leave the line. Silent clients fall out on their own.
2. **Connect within the token's expiry** (~45s) once `ready`, or your spot
   returns to the line.
3. **If a connect is ever refused, join again.** No error taxonomy, no
   backstop protocol — a fresh ticket is decided against the live capacity.

There is no session lifecycle to report (`started`, heartbeats, releases):
the queue observes session start/end on Decart's side.

## Running it

```sh
# from the repo root
pnpm install
pnpm --filter @decartai/sdk build

cd examples/realtime-session-queue-managed
cp .env.example .env    # point at your assigned queue URL / id / publishable key
pnpm dev                # app on :5173
```

Open two tabs and hit *Try it on* in each (a sample garment is preloaded):
with capacity saturated, the later tab waits with a live position and
inherits a slot the moment one frees — including when a session simply hits
its server-enforced duration cap.

The queue is **fail-open by design**: if it's unreachable, your app can fall
back to direct `realtime.connect()` calls — Decart's concurrency limit still
protects capacity; users just see "busy" instead of a line.
