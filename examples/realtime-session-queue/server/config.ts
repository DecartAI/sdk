import "dotenv/config";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

const decartApiKey = process.env.DECART_API_KEY;
if (!decartApiKey) {
  throw new Error("DECART_API_KEY is required — copy .env.example to .env and fill it in");
}

export const config = {
  port: int("PORT", 3000),
  decartApiKey,
  model: "lucy-vton-latest" as const,
  /** Concurrent sessions to allow. Must not exceed your account's realtime concurrency limit. */
  capacity: int("TRYON_CAPACITY", 10),
  /** Hard per-session cap. Decart enforces it server-side via the token constraint, so a
   *  killed app can never squat a slot longer than this — it's what keeps the queue moving. */
  maxSessionSeconds: int("MAX_SESSION_SECONDS", 120),
};
