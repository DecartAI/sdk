/**
 * Browser port of the server's E2E pixel-latency marker protocol
 * (`inference_server/rt/bench/pixel_marker.py`). Used to measure true
 * glass-to-glass latency through the realtime model: the client stamps a
 * monotonic sequence number into the bottom-left of every outgoing frame, the
 * server (with `pixel_latency` enabled) reads it on input and re-stamps it onto
 * the matching output frame, and the client reads it back on the rendered frame.
 *
 * The protocol works on the luma (Y) channel. The server writes Y∈{50,200};
 * here we stamp grayscale RGB blocks (R=G=B=v) so the encoder's RGB→YUV
 * conversion lands Y≈v, and we read by computing luma and thresholding at 128.
 * The 75-unit margin either side of 128, the SYNC pattern, the per-row checksum,
 * the 4 redundant rows, and the block-size auto-detect together survive VP8/VP9
 * quantization and WebRTC transport scaling.
 *
 * This is intentionally a line-for-line port of `pixel_marker.py` so the two
 * stay byte-compatible — keep the constants and bit layout in sync.
 */

/** Minimal structural shape of a canvas `ImageData` (RGBA, row-major). */
export type RGBAImageData = {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array;
};

const SYNC = [200, 50, 200, 50] as const;
const SYNC_LEN = SYNC.length;
const DATA_BITS = 16;
const CHECKSUM_BITS = 4;
/** 4 sync + 16 data + 4 checksum logical columns. */
const TOTAL_LOGICAL = SYNC_LEN + DATA_BITS + CHECKSUM_BITS;
/** Redundant logical rows, majority-voted on read. */
const MARKER_ROWS = 4;
/** Physical pixels per logical pixel when stamping (native resolution). */
const BLOCK_SIZE = 8;

/**
 * Candidate received block sizes, ordered by likelihood (nominal 8, no transport
 * scaling). Smaller values appear when WebRTC BWE downscales the stream; larger
 * when the sender upscales pre-encode. Mirrors `_CANDIDATE_BLOCK_SIZES`.
 */
const CANDIDATE_BLOCK_SIZES = [8, 4, 6, 2, 12, 10, 16, 5, 7, 14, 3] as const;

/** Smallest frame that can hold the marker at nominal block size. */
export const MIN_MARKER_WIDTH = TOTAL_LOGICAL * BLOCK_SIZE;
export const MIN_MARKER_HEIGHT = MARKER_ROWS * BLOCK_SIZE;
/** Tallest the marker can be in a received frame (largest auto-detect block size). */
export const MAX_MARKER_HEIGHT = MARKER_ROWS * Math.max(...CANDIDATE_BLOCK_SIZES);

/** BT.601 luma approximation (integer, matches a >=128 threshold either way). */
function luma(r: number, g: number, b: number): number {
  return (77 * r + 150 * g + 29 * b) >> 8;
}

const isHigh = (v: number): boolean => v >= 128;

/** XOR of the four 4-bit nibbles of the 16-bit seq (matches the server). */
function checksumNibbles(seq: number): number {
  let checksum = 0;
  for (let i = 0; i < DATA_BITS; i += 4) checksum ^= (seq >> i) & 0xf;
  return checksum;
}

/** The TOTAL_LOGICAL grayscale values for one logical row encoding `seq`. */
function rowValues(seq: number): number[] {
  const masked = seq & 0xffff;
  const values: number[] = [...SYNC];
  for (let i = 0; i < DATA_BITS; i++) {
    values.push((masked >> (DATA_BITS - 1 - i)) & 1 ? 200 : 50);
  }
  const checksum = checksumNibbles(masked);
  for (let i = 0; i < CHECKSUM_BITS; i++) {
    values.push((checksum >> (CHECKSUM_BITS - 1 - i)) & 1 ? 200 : 50);
  }
  return values; // length === TOTAL_LOGICAL
}

/**
 * Stamp `seq` into the bottom-left of `img` as grayscale blocks (mutates in
 * place). Returns false (no-op) if the frame is too small to hold the marker.
 * Always stamps at BLOCK_SIZE=8, matching the server's native-resolution stamp.
 */
export function stamp(img: RGBAImageData, seq: number): boolean {
  const { width, height, data } = img;
  if (width < MIN_MARKER_WIDTH || height < MIN_MARKER_HEIGHT) return false;

  const values = rowValues(seq);
  for (let logRow = 0; logRow < MARKER_ROWS; logRow++) {
    const rowStart = height - (MARKER_ROWS - logRow) * BLOCK_SIZE;
    for (let by = 0; by < BLOCK_SIZE; by++) {
      const y = rowStart + by;
      if (y < 0 || y >= height) continue;
      for (let logCol = 0; logCol < TOTAL_LOGICAL; logCol++) {
        const v = values[logCol];
        const xStart = logCol * BLOCK_SIZE;
        const xEnd = Math.min(xStart + BLOCK_SIZE, width);
        for (let x = xStart; x < xEnd; x++) {
          const o = (y * width + x) * 4;
          data[o] = v;
          data[o + 1] = v;
          data[o + 2] = v;
          data[o + 3] = 255;
        }
      }
    }
  }
  return true;
}

function syncMatches(rowValues: number[]): boolean {
  for (let i = 0; i < SYNC_LEN; i++) {
    if (isHigh(SYNC[i]) !== isHigh(rowValues[i])) return false;
  }
  return true;
}

/**
 * Read the marker seq from the bottom of `img`, or null if absent/unreadable.
 * Auto-detects the received block size so it works at any received resolution
 * (the transport may uniformly scale the frame after the server stamped it).
 */
export function read(img: RGBAImageData): number | null {
  const { width, height, data } = img;
  const sample = (row: number, col: number): number => {
    const o = (row * width + col) * 4;
    return luma(data[o], data[o + 1], data[o + 2]);
  };

  for (const blockSize of CANDIDATE_BLOCK_SIZES) {
    if (width < TOTAL_LOGICAL * blockSize || height < MARKER_ROWS * blockSize) continue;
    const seq = decodeAtBlockSize(sample, width, height, blockSize);
    if (seq !== null) return seq;
  }
  return null;
}

function decodeAtBlockSize(
  sample: (row: number, col: number) => number,
  width: number,
  height: number,
  blockSize: number,
): number | null {
  const half = blockSize >> 1;
  const validRows: number[][] = [];

  for (let logRow = 0; logRow < MARKER_ROWS; logRow++) {
    let row = height - (MARKER_ROWS - logRow) * blockSize + half;
    row = Math.max(0, Math.min(row, height - 1));
    const rv: number[] = [];
    for (let logCol = 0; logCol < TOTAL_LOGICAL; logCol++) {
      let col = logCol * blockSize + half;
      col = Math.max(0, Math.min(col, width - 1));
      rv.push(sample(row, col));
    }
    if (syncMatches(rv)) validRows.push(rv);
  }

  if (validRows.length === 0) return null;
  const threshold = validRows.length / 2;

  let seq = 0;
  for (let i = 0; i < DATA_BITS; i++) {
    let votes = 0;
    for (const rv of validRows) if (isHigh(rv[SYNC_LEN + i])) votes++;
    if (votes > threshold) seq |= 1 << (DATA_BITS - 1 - i);
  }

  const expectedChecksum = checksumNibbles(seq);
  let actualChecksum = 0;
  for (let i = 0; i < CHECKSUM_BITS; i++) {
    let votes = 0;
    for (const rv of validRows) if (isHigh(rv[SYNC_LEN + DATA_BITS + i])) votes++;
    if (votes > threshold) actualChecksum |= 1 << (CHECKSUM_BITS - 1 - i);
  }

  return expectedChecksum === actualChecksum ? seq : null;
}
