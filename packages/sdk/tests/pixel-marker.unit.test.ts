import { describe, expect, it } from "vitest";
import {
  MIN_MARKER_HEIGHT,
  MIN_MARKER_WIDTH,
  type RGBAImageData,
  read,
  stamp,
} from "../src/realtime/observability/pixel-marker.js";

function makeImage(width: number, height: number, fill = 0): RGBAImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill;
    data[i * 4 + 1] = fill;
    data[i * 4 + 2] = fill;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** Uniform nearest-neighbor scale — stands in for WebRTC transport up/downscaling. */
function scaleNearest(img: RGBAImageData, factor: number): RGBAImageData {
  const width = Math.round(img.width * factor);
  const height = Math.round(img.height * factor);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / factor));
      const sy = Math.min(img.height - 1, Math.floor(y / factor));
      const so = (sy * img.width + sx) * 4;
      const o = (y * width + x) * 4;
      data[o] = img.data[so];
      data[o + 1] = img.data[so + 1];
      data[o + 2] = img.data[so + 2];
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

describe("pixel-marker stamp/read", () => {
  it("round-trips a sweep of seqs at native resolution", () => {
    for (const seq of [0, 1, 2, 42, 255, 256, 1000, 0x1234, 0x7fff, 0xabcd, 0xffff]) {
      const img = makeImage(256, 256);
      expect(stamp(img, seq)).toBe(true);
      expect(read(img)).toBe(seq);
    }
  });

  it("masks seq to 16 bits (matches server seq & 0xFFFF)", () => {
    const img = makeImage(256, 256);
    stamp(img, 70_000); // 70000 & 0xffff === 4464
    expect(read(img)).toBe(70_000 & 0xffff);
  });

  it("no-ops and refuses to read on a frame too small for the marker", () => {
    const tiny = makeImage(MIN_MARKER_WIDTH - 1, MIN_MARKER_HEIGHT - 1);
    expect(stamp(tiny, 5)).toBe(false);
    expect(read(tiny)).toBeNull();
  });

  it("recovers the seq after the frame is downscaled (BWE) — block-size auto-detect", () => {
    const img = makeImage(256, 256);
    stamp(img, 0x2bcd);
    expect(read(scaleNearest(img, 0.5))).toBe(0x2bcd); // block 8 -> 4
  });

  it("recovers the seq after the frame is upscaled", () => {
    const img = makeImage(256, 256);
    stamp(img, 0x0777);
    expect(read(scaleNearest(img, 2))).toBe(0x0777); // block 8 -> 16
  });

  it("returns null on an unstamped frame (no false positive)", () => {
    expect(read(makeImage(256, 256, 0))).toBeNull();
    expect(read(makeImage(256, 256, 128))).toBeNull();
    expect(read(makeImage(256, 256, 255))).toBeNull();
  });

  it("rejects a corrupted marker via the checksum (no wrong seq)", () => {
    const img = makeImage(256, 256);
    stamp(img, 0x1234);
    // Flip a single data column (the MSB) across every redundant row: majority
    // vote decodes a seq one bit off, so its checksum no longer matches the
    // stored one and the read is rejected rather than returning a wrong seq.
    const { width, height, data } = img;
    const logCol = 4; // first data bit
    for (let logRow = 0; logRow < 4; logRow++) {
      const row = height - (4 - logRow) * 8 + 4;
      const sampleOffset = (row * width + (logCol * 8 + 4)) * 4;
      const flipped = data[sampleOffset] >= 128 ? 50 : 200;
      for (let bx = 0; bx < 8; bx++) {
        const o = (row * width + (logCol * 8 + bx)) * 4;
        data[o] = flipped;
        data[o + 1] = flipped;
        data[o + 2] = flipped;
      }
    }
    expect(read(img)).toBeNull();
  });

  it("survives a single corrupted redundant row via majority vote", () => {
    const img = makeImage(256, 256);
    stamp(img, 0x5a5a);
    // Destroy only the topmost redundant row (logRow 0); the other 3 still vote.
    const { width, height, data } = img;
    const row = height - 4 * 8 + 4;
    for (let x = 0; x < width; x++) {
      const o = (row * width + x) * 4;
      data[o] = 123;
      data[o + 1] = 123;
      data[o + 2] = 123;
    }
    expect(read(img)).toBe(0x5a5a);
  });
});
