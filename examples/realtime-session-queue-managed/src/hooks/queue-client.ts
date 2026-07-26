/**
 * Client for Decart's managed session queue, as a plain framework-free class
 * — React subscribes to it via useSyncExternalStore (see useQueue.ts). All
 * the stateful machinery (poll loop, cancellation, transitions) lives here
 * as ordinary code instead of hook callbacks and refs.
 *
 * The queue manages the LINE only — it never mints or holds credentials.
 * The contract: join() → "waiting" (polled every POLL_INTERVAL_MS) →
 * `granted` (your turn, valid for a claim window) → this client calls your
 * `fetchSession` (your own token endpoint) and goes "ready" → connect. If a
 * connect is ever refused, rejoin() — a fresh ticket, decided against the
 * live capacity. There is no session lifecycle to report: the queue
 * observes session start/end on Decart's side.
 */

export type GrantedSession = {
  apiKey: string;
  model: string;
  maxSessionSeconds: number;
};

export type QueueState =
  | { phase: "idle" }
  | { phase: "waiting"; position: number; queueSize: number }
  | { phase: "ready"; session: GrantedSession }
  | { phase: "error"; message: string };

export type QueueConfig = {
  url: string;
  queueId: string;
  publishableKey: string;
  /** Your token source, called when the queue grants a turn — typically a
   *  tiny endpoint on your backend that mints a short-lived Decart client
   *  token with your API key (see the express-proxy example). */
  fetchSession: () => Promise<GrantedSession>;
};

const POLL_INTERVAL_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class QueueClient {
  private state: QueueState = { phase: "idle" };
  private readonly listeners = new Set<() => void>();
  private ticketId: string | null = null;
  private joinInFlight = false;
  // Bumped on every transition that abandons in-flight work (join, leave,
  // rejoin, session end). The poll loop exits as soon as its epoch is stale
  // — one cancellation mechanism instead of per-callsite guards.
  private epoch = 0;

  constructor(private readonly config: QueueConfig) {}

  // Stable references on purpose: useSyncExternalStore contract.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): QueueState => this.state;

  join = async (): Promise<void> => {
    // Also guard the window before the POST returns — a double-tap must not
    // take two spots (the orphan would hold capacity until it lapses).
    if (this.ticketId || this.joinInFlight) return;
    this.joinInFlight = true;
    const epoch = ++this.epoch;
    try {
      const response = await this.request("/tickets", {
        method: "POST",
        headers: { "x-queue-key": this.config.publishableKey },
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))).error;
        // Re-check AFTER every await: a cancel (leave/dispose/rejoin) that
        // lands mid-parse must not have its state overwritten.
        if (epoch !== this.epoch) return;
        const message =
          error === "queue_full"
            ? "The line is full right now — please try again in a few minutes."
            : `Couldn't join the line (${error ?? response.status}).`;
        this.setState({ phase: "error", message });
        return;
      }
      const body = await response.json();
      if (epoch !== this.epoch) {
        // Cancelled while the ticket was being created/parsed: give the
        // spot straight back instead of leaving an orphan to decay.
        void this.request(`/tickets/${body.ticketId}`, { method: "DELETE", keepalive: true }).catch(() => {});
        return;
      }
      this.ticketId = body.ticketId;
      if (body.state === "granted") {
        // With free capacity the join itself answers granted — the common case.
        await this.claim(epoch);
        return;
      }
      this.setState({ phase: "waiting", position: body.position, queueSize: body.queueSize });
      void this.pollLoop(epoch);
    } catch (error) {
      if (epoch === this.epoch) {
        this.setState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      this.joinInFlight = false;
    }
  };

  /** Leave the line before being granted. */
  leave = (): void => {
    this.releaseTicket();
    this.setState({ phase: "idle" });
  };

  /** Session over (cleanly, or with a message worth showing). Nothing to
   *  tell the server: it sees the session end on Decart's side. */
  sessionEnded = (message?: string): void => {
    this.releaseTicket();
    this.setState(message ? { phase: "error", message } : { phase: "idle" });
  };

  /** The one recovery rule of the managed queue: if a connect is refused,
   *  join again — a fresh ticket, decided against the live capacity. */
  rejoin = (): void => {
    this.releaseTicket();
    this.setState({ phase: "waiting", position: 1, queueSize: 1 });
    void this.join();
  };

  /** Component unmounted: give the spot up without touching state. */
  dispose = (): void => {
    this.releaseTicket();
  };

  // Single exit path for a held ticket. Note: for a granted ticket the
  // server deliberately keeps the reservation until the claim window lapses
  // (a fetched token can't be revoked) — the DELETE only clears any
  // waiting-line state.
  private releaseTicket(): void {
    this.epoch++;
    const ticketId = this.ticketId;
    this.ticketId = null;
    if (ticketId) {
      void this.request(`/tickets/${ticketId}`, { method: "DELETE", keepalive: true }).catch(() => {});
    }
  }

  /** Our turn: fetch OUR token (the queue never has one) within the claim window. */
  private async claim(epoch: number): Promise<void> {
    try {
      const session = await this.config.fetchSession();
      if (epoch !== this.epoch) return;
      this.setState({ phase: "ready", session });
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.releaseTicket();
      this.setState({
        phase: "error",
        message: `Couldn't get a session token: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async pollLoop(epoch: number): Promise<void> {
    while (epoch === this.epoch && this.ticketId) {
      try {
        const response = await this.request(`/tickets/${this.ticketId}/poll`, { method: "POST" });
        if (epoch !== this.epoch) return;
        if (response.status === 410) {
          this.ticketId = null;
          this.setState({ phase: "error", message: "Your spot in line expired. Please join again." });
          return;
        }
        const body = await response.json();
        if (epoch !== this.epoch) return;
        if (body.state === "granted") {
          await this.claim(epoch);
          return;
        }
        this.setState({ phase: "waiting", position: body.position, queueSize: body.queueSize });
      } catch {
        // Transient network error; keep polling.
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  private setState(next: QueueState): void {
    // Skip no-op updates (e.g. an unchanged position every poll) so React
    // doesn't re-render on every tick.
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.config.url}/v1/queues/${this.config.queueId}${path}`, init);
  }
}
