import { describe, expect, it } from "vitest";
import { SeqTracker } from "../src/realtime/browser/glass-to-glass.js";

// Mid-stream samples are only counted past a 2s warm-up after the first frame,
// so tests establish a first frame, then feed steady-state samples well past it.
const PAST_WARMUP = 5_000;

describe("SeqTracker", () => {
  it("allocates monotonic 16-bit seqs that wrap at 0xffff", () => {
    const t = new SeqTracker();
    expect(t.stampNext(0)).toBe(0);
    expect(t.stampNext(0)).toBe(1);
    expect(t.stampNext(0)).toBe(2);
    const t2 = new SeqTracker();
    let last = -1;
    for (let i = 0; i < 0xffff; i++) last = t2.stampNext(0);
    expect(last).toBe(0xffff - 1);
    expect(t2.stampNext(0)).toBe(0xffff);
    expect(t2.stampNext(0)).toBe(0); // wrap
  });

  it("measures time-to-first-frame from markStart to the first rendered frame", () => {
    const t = new SeqTracker();
    t.markStart(1_000);
    const seq = t.stampNext(1_100);
    t.recordInbound(seq, 6_000); // first frame at 6000 → TTFF = 6000 - 1000
    const snap = t.snapshot();
    expect(snap.ttffMs).toBe(5_000);
    // The first frame is the cold-start frame; it does not count toward mid-stream.
    expect(snap.sampleCount).toBe(0);
    expect(snap.medianMs).toBeNull();
  });

  it("computes mid-stream latency percentiles, excluding the warm-up frames", () => {
    const t = new SeqTracker();
    t.markStart(0);
    const warm = t.stampNext(0);
    t.recordInbound(warm, 10); // first frame establishes warm-up window (not a sample)

    const latencies = [100, 200, 150, 300, 250];
    for (const latency of latencies) {
      const seq = t.stampNext(PAST_WARMUP);
      t.recordInbound(seq, PAST_WARMUP + latency); // matched well past warm-up
    }
    const snap = t.snapshot();
    expect(snap.sampleCount).toBe(5);
    expect(snap.medianMs).toBe(200); // sorted [100,150,200,250,300]
    expect(snap.p90Ms).toBe(300);
  });

  it("averages the two middle samples for an even-count median (no high skew)", () => {
    const t = new SeqTracker();
    t.markStart(0);
    const warm = t.stampNext(0);
    t.recordInbound(warm, 10); // first frame (warm-up, excluded)

    for (const latency of [100, 200, 150, 300]) {
      const seq = t.stampNext(PAST_WARMUP);
      t.recordInbound(seq, PAST_WARMUP + latency);
    }
    const snap = t.snapshot();
    expect(snap.sampleCount).toBe(4);
    expect(snap.medianMs).toBe(175); // sorted [100,150,200,300] -> (150 + 200) / 2
  });

  it("ignores unknown, duplicate, and implausible inbound seqs", () => {
    const t = new SeqTracker();
    const warm = t.stampNext(0);
    t.recordInbound(warm, 0); // first frame

    const seq = t.stampNext(PAST_WARMUP);
    t.recordInbound(9999, PAST_WARMUP + 10); // unknown seq
    t.recordInbound(seq, PAST_WARMUP + 120); // valid -> 120ms
    t.recordInbound(seq, PAST_WARMUP + 130); // duplicate (already consumed) -> ignored
    const seq2 = t.stampNext(PAST_WARMUP + 1_000);
    t.recordInbound(seq2, PAST_WARMUP + 500); // negative delta -> ignored
    const snap = t.snapshot();
    expect(snap.sampleCount).toBe(1);
    expect(snap.medianMs).toBe(120);
  });

  it("reports null drop ratio until enough outcomes exist", () => {
    const t = new SeqTracker();
    const warm = t.stampNext(0);
    t.recordInbound(warm, 0);
    const seq = t.stampNext(PAST_WARMUP);
    t.recordInbound(seq, PAST_WARMUP + 50);
    expect(t.snapshot().dropRatio).toBeNull(); // 1 outcome < DROP_MIN_OUTCOMES
  });

  it("infers end-to-end drops from seqs that age out unmatched (post warm-up)", () => {
    const t = new SeqTracker();
    const warm = t.stampNext(0);
    t.recordInbound(warm, 0); // first frame; subsequent stamps are post-warm-up

    // Stamp 286 past warm-up: 30 oldest (beyond MAX_PENDING=256) age out unmatched -> 30 drops.
    const seqs: number[] = [];
    for (let i = 0; i < 286; i++) seqs.push(t.stampNext(PAST_WARMUP));
    // Deliver 20 of the still-pending seqs.
    for (let i = 100; i < 120; i++) t.recordInbound(seqs[i], PAST_WARMUP + 100);
    const snap = t.snapshot();
    // 30 dropped + 20 delivered = 50 outcomes -> 0.6 drop ratio.
    expect(snap.dropRatio).toBeCloseTo(0.6, 5);
    expect(snap.sampleCount).toBe(20);
  });

  it("does not count pre-first-frame stamps as drops (pre-publish frames)", () => {
    const t = new SeqTracker();
    t.markStart(0);
    // 300 stamps before any frame ever renders (e.g. while still connecting).
    for (let i = 0; i < 300; i++) t.stampNext(i);
    // No match yet -> no outcomes recorded despite > MAX_PENDING evictions.
    expect(t.snapshot().dropRatio).toBeNull();
  });

  it("reset clears measurement state but keeps seq monotonic", () => {
    const t = new SeqTracker();
    t.markStart(0);
    const seq = t.stampNext(0);
    t.recordInbound(seq, 100);
    t.reset();
    expect(t.snapshot()).toEqual({ ttffMs: null, medianMs: null, p90Ms: null, sampleCount: 0, dropRatio: null });
    expect(t.stampNext(0)).toBe(1); // continues, not reset to 0
  });
});
