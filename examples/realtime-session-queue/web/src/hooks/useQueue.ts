import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Client half of the queue protocol. Deliberately uses nothing but `fetch`,
 * timers, and React state — no DOM APIs — so it ports to React Native as-is;
 * only the camera/rendering component next to it is platform-specific.
 *
 * Lifecycle: join() → "waiting" (poll every POLL_INTERVAL_MS) → "ready"
 * (credentials in hand) → sessionConnected() once the realtime connection is
 * established → endSession()/leave() → "idle". reportLimitReached() handles
 * the rare case where Decart still refused the connect: the server requeues
 * us at the head and we go back to "waiting".
 */

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

async function post(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`/api/tryon${path}`, { method: "POST", ...init });
}

export function useQueue(userId: string) {
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
      const response = await post(`/tickets/${ticketId}/poll`);
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

  /** Call once the realtime connection is established: extends the server
   *  lease from the 45s claim grace to the full session bound. Deliberately
   *  not at grant — a client stuck on the camera prompt stays reclaimable. */
  const sessionConnected = useCallback(() => {
    const ticketId = ticketRef.current;
    if (ticketId) void post(`/tickets/${ticketId}/started`).catch(() => {});
  }, []);

  const join = useCallback(async () => {
    if (ticketRef.current) return;
    try {
      const response = await post("/tickets", { headers: { "x-user-id": userId } });
      if (!response.ok) throw new Error(`join failed with ${response.status}`);
      const body = await response.json();
      ticketRef.current = body.ticketId;
      setStatus({ phase: "waiting", position: body.position, queueSize: body.queueSize });
      pollTimerRef.current = setTimeout(pollOnce, 0);
    } catch (error) {
      setStatus({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [userId, pollOnce]);

  const releaseTicket = useCallback((reason: "ended" | "limit_reached") => {
    const ticketId = ticketRef.current;
    if (!ticketId) return;
    // keepalive lets the request survive page navigation/close. React
    // Native's fetch has no keepalive; fire-and-forget works the same, and
    // the server-side lease expiry covers the app being killed outright.
    void post(`/tickets/${ticketId}/release`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
      keepalive: true,
    }).catch(() => {});
    if (reason !== "limit_reached") ticketRef.current = null;
  }, []);

  /** Session finished — cleanly or with an error (shown to the user). */
  const endSession = useCallback(
    (message?: string) => {
      stopPolling();
      releaseTicket("ended");
      setStatus(message ? { phase: "error", message } : { phase: "idle" });
    },
    [stopPolling, releaseTicket],
  );

  /** Backstop: Decart refused the connect with its concurrency close code.
   *  The server puts us back at the head of the line; resume polling. */
  const reportLimitReached = useCallback(() => {
    stopPolling();
    releaseTicket("limit_reached");
    setStatus({ phase: "waiting", position: 1, queueSize: 1 });
    pollTimerRef.current = setTimeout(pollOnce, POLL_INTERVAL_MS);
  }, [stopPolling, releaseTicket, pollOnce]);

  /** Leave the line before being granted a session. */
  const leave = useCallback(() => {
    stopPolling();
    releaseTicket("ended");
    setStatus({ phase: "idle" });
  }, [stopPolling, releaseTicket]);

  useEffect(() => {
    return () => {
      stopPolling();
      releaseTicket("ended");
    };
  }, [stopPolling, releaseTicket]);

  return { status, join, leave, sessionConnected, endSession, reportLimitReached };
}
