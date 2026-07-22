import { randomUUID } from "node:crypto";

/**
 * The whole queue: a FIFO waiting line plus capacity-bounded slot leases,
 * in memory. Good for one server instance — see README "Hardening for
 * production" for the shared-store mapping when you run more than one.
 *
 * Time flows in through `nowMs` and token minting through `mint`, so the
 * tests run instantly against fake versions of both.
 */

/** Credentials + rules handed to the client when its turn comes. */
export type GrantedSession = {
  /** Short-lived Decart client token — safe to hand to the app. */
  apiKey: string;
  /** Token (i.e. connect-window) expiry, ISO timestamp. */
  expiresAt: string;
  model: string;
  /** Hard cap enforced server-side by Decart; the app shows a countdown. */
  maxSessionSeconds: number;
};

export type TicketStatus =
  /** Still in line. `position` is 1-based; 1 means next to be granted. */
  | { state: "waiting"; position: number; queueSize: number }
  | { state: "ready"; session: GrantedSession }
  /** Unknown, expired, or already released ticket. */
  | { state: "expired" };

type Waiter = { ticketId: string; userId: string; lastSeenMs: number };
type Lease = { userId: string; expiresAtMs: number; session: GrantedSession | null };

export type QueueOptions = {
  capacity: number;
  /** Grant → connect window; a no-show's slot returns to the line after this. */
  claimGraceMs: number;
  /** Connect → hard stop. Decart's maxSessionDuration ends the session itself;
   *  this just reclaims the lease shortly after (teardown slack included). */
  sessionLeaseMs: number;
  /** Waiting tickets must keep polling; silent ones leave the line after this. */
  waitingTtlMs: number;
  mint: () => Promise<GrantedSession>;
};

export class Queue {
  private waiting: Waiter[] = [];
  private leases = new Map<string, Lease>();
  private ticketByUser = new Map<string, string>();

  constructor(private opts: QueueOptions) {}

  /** Join the line. Idempotent per user: rejoining (extra tab, app restart)
   *  returns the existing live ticket instead of a second spot. */
  join(userId: string, nowMs: number): { ticketId: string } & TicketStatus {
    this.prune(nowMs);
    const existing = this.ticketByUser.get(userId);
    if (existing) {
      if (this.leases.has(existing)) {
        // Still holds a slot (e.g. restarted mid-session); the first poll
        // hands the credentials back.
        return { ticketId: existing, state: "waiting", position: 0, queueSize: this.waiting.length };
      }
      const waiter = this.waiting.find((w) => w.ticketId === existing);
      if (waiter) {
        waiter.lastSeenMs = nowMs;
        return { ticketId: existing, ...this.waitingStatus(existing) };
      }
    }
    const ticketId = randomUUID();
    this.waiting.push({ ticketId, userId, lastSeenMs: nowMs });
    this.ticketByUser.set(userId, ticketId);
    return { ticketId, ...this.waitingStatus(ticketId) };
  }

  /**
   * Poll-as-claim: the poll that finds this ticket at the head of the line
   * with a free slot wins the slot, and the response carries the freshly
   * minted credentials. The token's own expiry doubles as the no-show
   * window — if the client never connects, both the token and the lease's
   * claim grace lapse on their own.
   */
  async poll(ticketId: string, nowMs: number): Promise<TicketStatus> {
    this.prune(nowMs);

    const lease = this.leases.get(ticketId);
    if (lease) {
      // `session` is null only while another poll's mint is in flight.
      return lease.session
        ? { state: "ready", session: lease.session }
        : { state: "waiting", position: 1, queueSize: this.waiting.length + 1 };
    }

    const index = this.waiting.findIndex((w) => w.ticketId === ticketId);
    if (index === -1) return { state: "expired" };
    this.waiting[index].lastSeenMs = nowMs;
    if (index > 0 || this.leases.size >= this.opts.capacity) {
      return { state: "waiting", position: index + 1, queueSize: this.waiting.length };
    }

    // Head of the line + free slot. Reserve the lease *before* awaiting the
    // mint so concurrent polls can't grant past capacity.
    const [waiter] = this.waiting.splice(index, 1);
    const reserved: Lease = { userId: waiter.userId, expiresAtMs: nowMs + this.opts.claimGraceMs, session: null };
    this.leases.set(ticketId, reserved);
    try {
      reserved.session = await this.opts.mint();
      return { state: "ready", session: reserved.session };
    } catch (error) {
      console.error("Token mint failed, returning the slot to the line:", error);
      this.leases.delete(ticketId);
      this.waiting.unshift(waiter);
      return { state: "waiting", position: 1, queueSize: this.waiting.length };
    }
  }

  /** The app's realtime connection is up: extend the lease from the claim
   *  grace to the full session bound. Deliberately a one-shot transition —
   *  a client stuck on the camera prompt stays reclaimable. */
  started(ticketId: string, nowMs: number): boolean {
    const lease = this.leases.get(ticketId);
    if (!lease) return false;
    lease.expiresAtMs = nowMs + this.opts.sessionLeaseMs;
    return true;
  }

  /** `requeue` is the 1013 backstop: the ticket goes back to the *head* of
   *  the line, so the user recovers their place instead of losing it. */
  release(ticketId: string, requeue: boolean, nowMs: number): void {
    const lease = this.leases.get(ticketId);
    if (lease) {
      this.leases.delete(ticketId);
      if (requeue) {
        this.waiting.unshift({ ticketId, userId: lease.userId, lastSeenMs: nowMs });
      } else {
        this.ticketByUser.delete(lease.userId);
      }
      return;
    }
    const index = this.waiting.findIndex((w) => w.ticketId === ticketId);
    if (index !== -1) {
      this.ticketByUser.delete(this.waiting[index].userId);
      this.waiting.splice(index, 1);
    }
  }

  stats(nowMs: number): { waiting: number; active: number; capacity: number } {
    this.prune(nowMs);
    return { waiting: this.waiting.length, active: this.leases.size, capacity: this.opts.capacity };
  }

  private waitingStatus(ticketId: string): TicketStatus {
    const index = this.waiting.findIndex((w) => w.ticketId === ticketId);
    return { state: "waiting", position: index + 1, queueSize: this.waiting.length };
  }

  private prune(nowMs: number): void {
    for (const [ticketId, lease] of this.leases) {
      if (lease.expiresAtMs <= nowMs) {
        this.leases.delete(ticketId);
        this.ticketByUser.delete(lease.userId);
      }
    }
    this.waiting = this.waiting.filter((waiter) => {
      if (nowMs - waiter.lastSeenMs <= this.opts.waitingTtlMs) return true;
      this.ticketByUser.delete(waiter.userId);
      return false;
    });
  }
}
