# realtime-session-queue-managed

Client reference for **Decart's managed session queue**. When your account's
realtime concurrency is at its limit, your users wait in a fair line with
live position feedback. The queue manages the *line only* — it never mints,
holds, or sees credentials. When it's your user's turn, your app fetches a
token from **your own** token endpoint (the standard realtime integration —
see [`../express-proxy`](../express-proxy) for the pattern) and connects.

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
 │             ...                     │  granted → { claimSecondsLeft }
 │
 │  POST your-backend/token   →  { apiKey }     (YOUR mint endpoint, YOUR key)
 │  realtime.connect(apiKey)  — connect within the claim window
 │  (session ends → Decart sees it; nothing to report back)
```

Three rules, and that's the integration:

1. **Poll every ~2s while waiting**; stop polling (or `DELETE` the ticket) to
   leave the line. Silent clients fall out on their own.
2. **On `granted`, fetch your token and connect within the claim window**
   (~45s), or your spot returns to the line. Mint with a short `expiresIn`
   and `constraints.realtime.maxSessionDuration` set — the session cap is
   what keeps the line moving.
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
cp .env.example .env    # queue URL/id/key + YOUR token endpoint URL
pnpm dev                # app on :5173
```

Open two tabs and hit *Try it on* in each (a sample garment is preloaded):
with capacity saturated, the later tab waits with a live position and
inherits a slot the moment one frees — including when a session simply hits
its server-enforced duration cap.

The queue is **fail-open by design**: if it's unreachable, your app can fall
back to direct `realtime.connect()` calls — Decart's concurrency limit still
protects capacity; users just see "busy" instead of a line.
