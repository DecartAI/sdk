import { createDecartClient } from "@decartai/sdk";
import express from "express";
import { config } from "./config.js";
import { type GrantedSession, Queue } from "./queue.js";

const decart = createDecartClient({ apiKey: config.decartApiKey });

const queue = new Queue({
  capacity: config.capacity,
  claimGraceMs: 45_000,
  sessionLeaseMs: (config.maxSessionSeconds + 30) * 1000,
  waitingTtlMs: 30_000,
  mint: async (): Promise<GrantedSession> => {
    const token = await decart.tokens.create({
      // The window the client has to *connect*, not the session length.
      expiresIn: 60,
      allowedModels: [config.model],
      constraints: { realtime: { maxSessionDuration: config.maxSessionSeconds } },
    });
    return {
      apiKey: token.apiKey,
      expiresAt: token.expiresAt,
      model: config.model,
      maxSessionSeconds: config.maxSessionSeconds,
    };
  },
});

const app = express();
app.use(express.json());

// Express 4 doesn't catch rejected promises from async handlers; route them
// to the default error handler (500) instead of an unhandled rejection.
function asyncHandler(fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler {
  return (req, res, next) => fn(req, res).catch(next);
}

/** Stand-in for real user authentication — see README before shipping. */
function requireUserId(req: express.Request, res: express.Response): string | null {
  const userId = req.header("x-user-id");
  if (!userId) {
    res.status(401).json({ error: "missing x-user-id header" });
    return null;
  }
  return userId;
}

app.post("/api/tryon/tickets", (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  res.json(queue.join(userId, Date.now()));
});

app.post(
  "/api/tryon/tickets/:ticketId/poll",
  asyncHandler(async (req, res) => {
    const status = await queue.poll(req.params.ticketId, Date.now());
    res.status(status.state === "expired" ? 410 : 200).json(status);
  }),
);

app.post("/api/tryon/tickets/:ticketId/started", (req, res) => {
  if (!queue.started(req.params.ticketId, Date.now())) {
    res.status(410).json({ state: "expired" });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/tryon/tickets/:ticketId/release", (req, res) => {
  const reason = req.body?.reason;
  if (reason !== "ended" && reason !== "limit_reached") {
    res.status(400).json({ error: 'reason must be "ended" or "limit_reached"' });
    return;
  }
  queue.release(req.params.ticketId, reason === "limit_reached", Date.now());
  res.json({ ok: true });
});

app.get("/api/tryon/stats", (_req, res) => {
  res.json(queue.stats(Date.now()));
});

app.listen(config.port, () => {
  console.log(`Gatekeeper listening on http://localhost:${config.port}`);
  console.log(`Capacity: ${config.capacity} concurrent sessions, ${config.maxSessionSeconds}s max each`);
});
