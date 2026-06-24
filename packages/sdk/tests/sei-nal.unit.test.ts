import { describe, expect, it } from "vitest";
import { buildSeiNal, extractSeiPayload, injectSeiIntoNals } from "../src/realtime/sei/sei-nal.js";

const enc = (s: string) => new TextEncoder().encode(s);
const arr = (u: Uint8Array | null) => (u === null ? null : Array.from(u));

function annexb(nals: Uint8Array[]): Uint8Array {
  const out: number[] = [];
  for (const n of nals) out.push(0, 0, 0, 1, ...n);
  return new Uint8Array(out);
}

function contains(buf: Uint8Array, seq: number[]): boolean {
  outer: for (let i = 0; i <= buf.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
    return true;
  }
  return false;
}

describe("sei-nal codec", () => {
  it("round-trips build -> extract", () => {
    const payload = enc("hello-g2g-12345");
    const stream = new Uint8Array([0, 0, 0, 1, ...buildSeiNal(payload)]);
    expect(arr(extractSeiPayload(stream))).toEqual(arr(payload));
  });

  it("returns null when no Decart SEI is present", () => {
    const stream = new Uint8Array([0, 0, 0, 1, 0x41, 0, 1, 2]); // fake non-IDR slice
    expect(extractSeiPayload(stream)).toBeNull();
  });

  it("built NAL has no start-code emulation (00 00 00/01/02)", () => {
    const payload = new Uint8Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0, 3]);
    const nal = buildSeiNal(payload);
    expect(contains(nal, [0, 0, 0])).toBe(false);
    expect(contains(nal, [0, 0, 1])).toBe(false);
    expect(contains(nal, [0, 0, 2])).toBe(false);
  });

  it("round-trips a payload containing emulation sequences", () => {
    const payload = new Uint8Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0, 3, 255, 0, 0]);
    const stream = new Uint8Array([0, 0, 0, 1, ...buildSeiNal(payload)]);
    expect(arr(extractSeiPayload(stream))).toEqual(arr(payload));
  });

  it("round-trips a large payload (multi-byte ff size)", () => {
    const payload = new Uint8Array(600).fill(0x78);
    const stream = new Uint8Array([0, 0, 0, 1, ...buildSeiNal(payload)]);
    expect(arr(extractSeiPayload(stream))).toEqual(arr(payload));
  });

  it("injects SEI before the first VCL slice", () => {
    const nals = [new Uint8Array([0x67, 1, 2]), new Uint8Array([0x68, 3, 4]), new Uint8Array([0x65, 9, 9, 9])];
    const types = injectSeiIntoNals(nals, enc("ts=42")).map((n) => n[0] & 0x1f);
    expect(types).toContain(6);
    expect(types.indexOf(6)).toBeLessThan(types.indexOf(5));
  });

  it("injected payload is extractable", () => {
    const out = injectSeiIntoNals([new Uint8Array([0x65, 9, 9, 9])], enc("ts=42"));
    expect(arr(extractSeiPayload(annexb(out)))).toEqual(arr(enc("ts=42")));
  });
});
