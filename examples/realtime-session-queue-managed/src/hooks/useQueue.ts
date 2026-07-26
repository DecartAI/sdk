import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Client for Decart's managed session queue. Uses nothing but `fetch`,
 * timers, and React state — no DOM APIs — so it ports to React Native as-is.
 *
 * The whole contract: join() → "waiting" (poll every POLL_INTERVAL_MS) →
 * "ready" (short-lived Decart token in hand) → connect within its expiry.
 * Leaving = leave() or simply stopping to poll. If a connect is ever
 * refused, rejoin() — a new ticket, decided against the live capacity.
 * There is no session lifecycle to report: the queue observes session
 * start/end on Decart's side.
 */

const QUEUE_URL = import.meta.env.VITE_QUEUE_URL ?? "http://localhost:8321";
const QUEUE_ID = import.meta.env.VITE_QUEUE_ID ?? "test";
const QUEUE_KEY = import.meta.env.VITE_QUEUE_KEY ?? "pk_dev";

export type GrantedSession = {
  apiKey: string;
  expiresAt: string;
  model: string;
  maxSessionSeconds: number;
};

export type QueueStatus =
  | { phase: "idle" }
  | { phase: "waiting"; position: number; queueSize: number }
  | { phase: "ready"; session: GrantedSession }
  | { phase: "error"; message: string };

const POLL_INTERVAL_MS = 2000;

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${QUEUE_URL}/v1/queues/${QUEUE_ID}${path}`, init);
}

export function useQueue() {
  const [status, setStatus] = useState<QueueStatus>({ phase: "idle" });
  const ticketRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }, []);

  const pollOnce = useCallback(async () => {
    const ticketId = ticketRef.current;
    if (!ticketId) return;
    try {
      const response = await request(`/tickets/${ticketId}/poll`, { method: "POST" });
      // The user left or the session ended while this poll was in flight.
      if (ticketRef.current !== ticketId) return;
      if (response.status === 410) {
        stopPolling();
        ticketRef.current = null;
        setStatus({ phase: "error", message: "Your spot in line expired. Please join again." });
        return;
      }
      const body = await response.json();
      if (body.state === "ready") {
        setStatus({ phase: "ready", session: body.session });
        return;
      }
      setStatus({ phase: "waiting", position: body.position, queueSize: body.queueSize });
    } catch {
      // Transient network error; keep polling.
    }
    pollTimerRef.current = setTimeout(pollOnce, POLL_INTERVAL_MS);
  }, [stopPolling]);

  const join = useCallback(async () => {
    if (ticketRef.current) return;
    try {
      const response = await request("/tickets", {
        method: "POST",
        headers: { "x-queue-key": QUEUE_KEY },
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))).error;
        const message =
          error === "queue_full"
            ? "The line is full right now — please try again in a few minutes."
            : `Couldn't join the line (${error ?? response.status}).`;
        setStatus({ phase: "error", message });
        return;
      }
      const body = await response.json();
      ticketRef.current = body.ticketId;
      setStatus({ phase: "waiting", position: body.position, queueSize: body.queueSize });
      pollTimerRef.current = setTimeout(pollOnce, 0);
    } catch (error) {
      setStatus({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [pollOnce]);

  /** Session over (cleanly, or with a message worth showing). Nothing to
   *  tell the server: it sees the session end on Decart's side. */
  const sessionEnded = useCallback(
    (message?: string) => {
      stopPolling();
      ticketRef.current = null;
      setStatus(message ? { phase: "error", message } : { phase: "idle" });
    },
    [stopPolling],
  );

  /** The one recovery rule of the managed queue: if a connect is refused,
   *  join again — a fresh ticket, decided against the live capacity. */
  const rejoin = useCallback(() => {
    stopPolling();
    ticketRef.current = null;
    setStatus({ phase: "waiting", position: 1, queueSize: 1 });
    void join();
  }, [stopPolling, join]);

  /** Leave the line before being granted. */
  const leave = useCallback(() => {
    stopPolling();
    const ticketId = ticketRef.current;
    ticketRef.current = null;
    if (ticketId) {
      void request(`/tickets/${ticketId}`, { method: "DELETE", keepalive: true }).catch(() => {});
    }
    setStatus({ phase: "idle" });
  }, [stopPolling]);

  useEffect(() => {
    return () => {
      stopPolling();
      const ticketId = ticketRef.current;
      ticketRef.current = null;
      if (ticketId) {
        void request(`/tickets/${ticketId}`, { method: "DELETE", keepalive: true }).catch(() => {});
      }
    };
  }, [stopPolling]);

  return { status, join, leave, sessionEnded, rejoin };
}
