/**
 * H.264 SEI latency-marker codec (browser/worker side).
 *
 * Mirror of the server's `inference_server/rt/bench/sei.py`: carries an opaque
 * per-frame payload inside a `user_data_unregistered` SEI message (payloadType
 * 5) tagged with the Decart UUID. Pure byte manipulation — no DOM/WebRTC deps —
 * so it runs in a worker and unit-tests in isolation.
 */

// 16-byte UUID identifying a Decart latency marker among other SEI messages.
// Must byte-match DECART_SEI_UUID in the Python codec.
export const DECART_SEI_UUID = new Uint8Array([
  0xde, 0xca, 0x27, 0x5e, 0x1a, 0x2b, 0x4c, 0x3d, 0x8e, 0x9f, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55,
]);

const SEI_NAL_TYPE = 6;
const USER_DATA_UNREGISTERED = 5;
const RBSP_TRAILING = 0x80;
const START_CODE = [0, 0, 1];

function encodeFf(value: number): number[] {
  const out: number[] = [];
  while (value >= 0xff) {
    out.push(0xff);
    value -= 0xff;
  }
  out.push(value);
  return out;
}

function readFf(buf: Uint8Array, pos: number): [number | null, number] {
  let val = 0;
  const n = buf.length;
  while (pos < n && buf[pos] === 0xff) {
    val += 0xff;
    pos++;
  }
  if (pos >= n) return [null, pos];
  val += buf[pos];
  return [val, pos + 1];
}

/** Insert emulation_prevention_three_byte so no 00 00 0x start-code forms. */
function emulationEscape(rbsp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 0x03) {
      out.push(0x03);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}

/** Strip emulation_prevention_three_byte to recover the raw RBSP. */
function emulationUnescape(ebsp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  const n = ebsp.length;
  let i = 0;
  while (i < n) {
    const b = ebsp[i];
    if (zeros >= 2 && b === 0x03 && i + 1 < n && ebsp[i + 1] <= 0x03) {
      zeros = 0;
      i++;
      continue;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
    i++;
  }
  return new Uint8Array(out);
}

/** Build a raw SEI NAL unit (no Annex-B start code) carrying `payload`. */
export function buildSeiNal(payload: Uint8Array): Uint8Array {
  const data = new Uint8Array(DECART_SEI_UUID.length + payload.length);
  data.set(DECART_SEI_UUID, 0);
  data.set(payload, DECART_SEI_UUID.length);

  const rbsp: number[] = [];
  rbsp.push(...encodeFf(USER_DATA_UNREGISTERED));
  rbsp.push(...encodeFf(data.length));
  for (const b of data) rbsp.push(b);
  rbsp.push(RBSP_TRAILING);

  const escaped = emulationEscape(new Uint8Array(rbsp));
  const nal = new Uint8Array(1 + escaped.length);
  nal[0] = SEI_NAL_TYPE;
  nal.set(escaped, 1);
  return nal;
}

function findSeq(buf: Uint8Array, seq: number[], from: number): number {
  outer: for (let i = from; i <= buf.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

/** Yield NAL units (without start codes) from an Annex-B bitstream. */
export function iterNalUnits(annexb: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let i = findSeq(annexb, START_CODE, 0);
  while (i !== -1) {
    i += START_CODE.length;
    const start = i;
    const nxt = findSeq(annexb, START_CODE, i);
    if (nxt === -1) {
      nals.push(annexb.subarray(start));
      break;
    }
    // A 4-byte start code (00 00 00 01) leaves a trailing 0x00 on the prior NAL.
    const end = annexb[nxt - 1] === 0 ? nxt - 1 : nxt;
    nals.push(annexb.subarray(start, end));
    i = nxt;
  }
  return nals;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function parseDecartSeiRbsp(rbsp: Uint8Array): Uint8Array | null {
  let pos = 0;
  const n = rbsp.length;
  while (pos < n && rbsp[pos] !== RBSP_TRAILING) {
    let ptype: number | null;
    [ptype, pos] = readFf(rbsp, pos);
    if (ptype === null) return null;
    let psize: number | null;
    [psize, pos] = readFf(rbsp, pos);
    if (psize === null || pos + psize > n) return null;
    const chunk = rbsp.subarray(pos, pos + psize);
    pos += psize;
    if (
      ptype === USER_DATA_UNREGISTERED &&
      chunk.length >= 16 &&
      bytesEqual(chunk.subarray(0, 16), DECART_SEI_UUID)
    ) {
      return chunk.slice(16); // copy out of the view
    }
  }
  return null;
}

/** Return the Decart latency payload from an Annex-B access unit, or null. */
export function extractSeiPayload(annexb: Uint8Array): Uint8Array | null {
  for (const nal of iterNalUnits(annexb)) {
    if (nal.length && (nal[0] & 0x1f) === SEI_NAL_TYPE) {
      const payload = parseDecartSeiRbsp(emulationUnescape(nal.subarray(1)));
      if (payload !== null) return payload;
    }
  }
  return null;
}

/**
 * Return `nals` with a Decart SEI NAL inserted before the first VCL slice.
 * NAL units are start-code-free; SEI precedes the first VCL NAL (types 1–5),
 * or is prepended if the access unit has none.
 */
export function injectSeiIntoNals(nals: Uint8Array[], payload: Uint8Array): Uint8Array[] {
  const seiNal = buildSeiNal(payload);
  for (let idx = 0; idx < nals.length; idx++) {
    const t = nals[idx][0] & 0x1f;
    if (nals[idx].length && t >= 1 && t <= 5) {
      return [...nals.slice(0, idx), seiNal, ...nals.slice(idx)];
    }
  }
  return [seiNal, ...nals];
}
