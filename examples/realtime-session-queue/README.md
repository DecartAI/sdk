# realtime-session-queue

Reference implementation of a **customer-side waiting queue** for capacity-limited realtime sessions. Use it when your account has a realtime concurrency limit (say, 10 sessions) and you want users beyond that limit to wait in a fair line with live position feedback — instead of seeing failed connections.

The scenario modeled here is a virtual try-on experience (`lucy-vton-latest`), but the pattern applies to any realtime model.

> This is *not* Decart's jobs/queue API (`client.queue`, for async video). It's a gate you run in front of `client.realtime.connect()`.

## The idea

Your backend already has to hold your Decart API key and mint [ephemeral client tokens](https://docs.platform.decart.ai) for your app. The queue is nothing more than deciding **when to mint the next token**:

```
App                        Your gatekeeper (this example)              Decart
 │  POST /api/tryon/tickets  │                                           │
 ├──────────────────────────>│ enqueue                                   │
 │   { ticketId, position }  │                                           │
 │  POST .../poll (every 2s) │                                           │
 ├──────────────────────────>│ waiting → { position, queueSize }         │
 │          ...              │                                           │
 ├──────────────────────────>│ head of line + free slot?                 │
 │                           ├── tokens.create(expiresIn, maxSessionDuration)
 │   { state: "ready",       │<──────────────────────────────────────────┤
 │     session: { apiKey } } │                                           │
 │<──────────────────────────┤                                           │
 │  realtime.connect(apiKey) — WebSocket + WebRTC, key never in the app  │
 ├───────────────────────────────────────────────────────────────────────>
 │  POST .../started once connected                                      │
 │  POST .../release { reason } when done                                │
```

Three properties make this robust without needing to be clever:

1. **The token is the no-show timeout.** A granted token expires in 60s (`expiresIn`) — that's the *connect window*, not the session length. If the user never connects, the token dies on its own and the slot's claim grace (45s) returns it to the line.
2. **Decart enforces the session cap for you.** The token carries `constraints.realtime.maxSessionDuration` (120s here). Decart kills the session server-side when it's up — even if the app was backgrounded or killed — so a slot can never be squatted and the queue always moves.
3. **Decart is the backstop for races.** The gate keeps you at/below the limit, but if a connect still gets refused (see below), the app reports `limit_reached` and the server requeues that ticket **at the head of the line** — the user recovers on the next poll instead of losing their place.

## Slot lifecycle

A granted slot is a *lease* with exactly two phases:

| Phase | Freed by |
|---|---|
| Granted, not yet connected | Explicit `release`, or the 45s claim grace (camera prompt abandoned, app died) |
| Connected (`started` reported) | Explicit `release`, or the session bound (`maxSessionDuration` + 30s slack) |

Waiting tickets have the same protection: a ticket that stops polling for 30s leaves the line, so closed apps don't hold up the queue.

## What happens on Decart's side

Your concurrency limit is enforced per organization (or per user, for user-scoped keys) — every ephemeral token minted from the same key counts into one bucket, checked **once at connect time**:

- Over the limit → the WebSocket is closed with code **1013** and an error message `"Concurrent session limit reached."`. A session that's already running is never dropped for concurrency.
- A cleanly disconnected session frees its slot within ~5s; a crashed one within ~45s. This lag is exactly why the `limit_reached` backstop exists: your gate can believe a slot is free slightly before Decart does.
- The SDK currently retries connect errors with backoff before surfacing them, so a 1013 rejection takes ~30s to reach your error handler. This cuts both ways: if capacity frees up mid-retry, the SDK connects on its own and the backstop never fires. It's rare either way — the gate prevents it in the common case — but don't treat the retry delay as a hang.

## Running it

```sh
# from the repo root
pnpm install
pnpm --filter @decartai/sdk build

cd examples/realtime-session-queue
cp .env.example .env       # add your DECART_API_KEY
pnpm dev                   # gatekeeper on :3000, web app on :5173
```

Open http://localhost:5173, pick a garment photo, and hit *Try it on*.

**Watching the queue actually queue:** set `TRYON_CAPACITY=1` in `.env`, open two browser windows (one in private browsing, so it gets a different user id), and start a session in each. The second window waits with a live position, and is granted the slot as soon as the first session ends — or after at most `MAX_SESSION_SECONDS`.

```sh
curl -s localhost:3000/api/tryon/stats   # { waiting, active, capacity }
```

The queue semantics (FIFO, no-show reclaim, session bound, requeue-at-head, ...) are covered by `pnpm test` — the queue takes time and token-minting as inputs (`server/queue.ts`), so the tests are instant and deterministic.

## Protocol

| Endpoint | Purpose |
|---|---|
| `POST /api/tryon/tickets` | Join the line (idempotent per user — no cutting the line with extra tabs). Header `x-user-id` stands in for your real auth. |
| `POST /api/tryon/tickets/:id/poll` | Poll every ~2s. Returns `waiting` (position), `ready` (session credentials), or `410` if the ticket expired. **Polling is also the claim**: the poll that finds you at the head of a free slot mints your token. |
| `POST /api/tryon/tickets/:id/started` | Once, when `realtime.connect()` succeeds — extends the lease from the claim grace to the full session bound. |
| `POST /api/tryon/tickets/:id/release` | `{ reason: "ended" \| "limit_reached" }`. `limit_reached` requeues at the head. |
| `GET /api/tryon/stats` | `{ waiting, active, capacity }` for dashboards/ops. |

Plain short-poll keeps mobile clients simple and robust (backgrounding, flaky networks). If you want snappier updates later, swap the poll loop for SSE/WebSocket pushes without touching the queue.

## Porting the client to React Native

The queue client (`web/src/hooks/useQueue.ts`) intentionally uses only `fetch`, timers, and React state — it runs under React Native unchanged. What differs:

- **Realtime SDK**: `@decartai/sdk` ships a React Native entry point; the camera/rendering component (`TryOnSession.tsx`) is the only part you rewrite, same as any RN port.
- **Release on app close**: RN `fetch` has no `keepalive`; hook `AppState` changes to fire `release` when backgrounding. If the app is killed outright, the lease expires on its own — that's what it's for.
- **User identity**: replace the `localStorage` stand-in with your account/device id.

## Hardening for production

This example keeps every mechanism that makes the queue *correct* and drops what a demo doesn't need. Before shipping:

- **Auth**: replace the `x-user-id` header with your real user authentication on every endpoint.
- **Never ship your API key in the app.** The app only ever sees the short-lived token (that's the point of this whole design).
- **Multiple server instances**: the in-memory state in `server/queue.ts` assumes one instance. The state maps directly onto a shared store — waiting line → sorted set keyed by a monotonic sequence, leases → sorted set keyed by expiry — with one rule: the head-of-line check and lease reservation in `poll()` must be atomic (a Redis Lua script, or a transactional `SELECT ... FOR UPDATE`). This is the same technique Decart's own limiter uses.
- **Faster reclaim of crashed apps**: the lease is only reclaimed at the session bound (~2.5 min worst case) if the app dies mid-session without releasing. If that's too slow, have the app heartbeat every ~10s and expire leases ~30s after the last beat.
- **Wait-time estimates**: track recent session durations and show `position × avg ÷ capacity` next to the position.
- **Shrinking the race window**: `GET /v1/realtime/quota` (with your API key) returns your live `{ limit, active, remaining }` — cross-check it before granting if you want to make `limit_reached` even rarer.
- **Capacity**: run `TRYON_CAPACITY` at your account limit; the backstop handles the rare race. Remember the limit is org-wide — other realtime usage on the same account eats into it.
- **Tune `MAX_SESSION_SECONDS`** — it's the single biggest lever on queue throughput: wait time ≈ position × session length ÷ capacity.
- **Priority tiers**, if you need them later, are one change: order the waiting line by (tier, arrival) instead of arrival alone.
