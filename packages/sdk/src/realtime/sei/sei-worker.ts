/**
 * WebRTC Encoded Transform worker for H.264 SEI glass-to-glass latency.
 *
 * Runs as an `RTCRtpScriptTransform` worker. Two operations, selected via the
 * transform's options:
 *   - "inject"  (sender side):  prepend a Decart SEI NAL carrying Date.now()
 *                               onto each encoded frame's bitstream.
 *   - "parse"   (receiver side): read the SEI off each encoded frame and post
 *                               the measured latency (now - stamped) to the page.
 *
 * `RTCEncodedVideoFrame.data` is the raw encoded H.264 bitstream (Annex-B NAL
 * units) — this is the browser API that gives JS access to where SEI lives.
 * Date.now() is wall-clock, so it is comparable across the page's realms (and,
 * in the real flow, across the same client that both sends and receives).
 */

import { buildSeiNal, extractSeiPayload } from "./sei-nal.js";

const START_CODE_4 = [0, 0, 0, 1];

function prependSei(data: Uint8Array, payload: Uint8Array): Uint8Array {
  const sei = buildSeiNal(payload);
  const out = new Uint8Array(START_CODE_4.length + sei.length + data.length);
  out.set(START_CODE_4, 0);
  out.set(sei, START_CODE_4.length);
  out.set(data, START_CODE_4.length + sei.length);
  return out;
}

type EncodedFrame = { data: ArrayBuffer };

interface RtcTransformEvent extends Event {
  transformer: {
    readable: ReadableStream<EncodedFrame>;
    writable: WritableStream<EncodedFrame>;
    options?: { operation?: "inject" | "parse" };
  };
}

const scope = self as unknown as {
  onrtctransform: ((event: RtcTransformEvent) => void) | null;
  postMessage: (message: unknown) => void;
};

let injected = 0;
let parseSeen = 0;
let parseMatched = 0;

scope.onrtctransform = (event: RtcTransformEvent) => {
  const { readable, writable, options } = event.transformer;
  const operation = options?.operation;
  scope.postMessage({ type: "sei-attached", operation });

  const pipe = new TransformStream<EncodedFrame, EncodedFrame>({
    transform(frame, controller) {
      try {
        if (operation === "inject") {
          const stamp = new TextEncoder().encode(String(Date.now()));
          frame.data = prependSei(new Uint8Array(frame.data), stamp).buffer;
          injected++;
          if (injected % 30 === 0) scope.postMessage({ type: "sei-stats", injected });
        } else if (operation === "parse") {
          parseSeen++;
          const payload = extractSeiPayload(new Uint8Array(frame.data));
          if (payload) {
            parseMatched++;
            const sentMs = Number(new TextDecoder().decode(payload));
            if (Number.isFinite(sentMs)) {
              scope.postMessage({ type: "sei-latency", latencyMs: Date.now() - sentMs });
            }
          }
          if (parseSeen % 30 === 0) scope.postMessage({ type: "sei-stats", parseSeen, parseMatched });
        }
      } catch (err) {
        scope.postMessage({ type: "sei-error", message: String(err) });
      }
      controller.enqueue(frame);
    },
  });

  readable.pipeThrough(pipe).pipeTo(writable).catch(() => {});
};
