import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareBrowserConnection } from "../src/realtime/browser/prepare-connection.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
// mirror is off, so the stream is passed through untouched — a stub avoids
// needing a `MediaStream` global in the node test environment.
const fakeStream = { getVideoTracks: () => [] } as unknown as MediaStream;
const baseArgs = {
  stream: fakeStream,
  mirror: false as const,
  fps: 30,
  logger,
  observability: { logger },
};

// Chromium is the insertable-streams path: it ships createEncodedStreams on
// both sender and receiver, which is what LiveKit's worker pipeline uses.
function stubFrameMetadataRuntimeSupport() {
  vi.stubGlobal("window", {
    navigator: { userAgent: "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36" },
    RTCRtpSender: { prototype: { createEncodedStreams() {} } },
    RTCRtpReceiver: { prototype: { createEncodedStreams() {} } },
  });
}

describe("prepareBrowserConnection frame-timing gating", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not advertise frame timing when the frame-metadata worker cannot be created", () => {
    // The server appends a packet trailer to every frame once frame timing is
    // advertised; without a strip worker the decoder chokes. So a worker that
    // can't be constructed (e.g. blocked by CSP) must keep frame timing off.
    stubFrameMetadataRuntimeSupport();
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("worker blocked");
        }
      },
    );
    const debug = vi.fn();

    const prepared = prepareBrowserConnection({ ...baseArgs, logger: { ...logger, debug } });

    expect(prepared.frameTiming).toBe(false);
    expect(debug).toHaveBeenCalled();
    prepared.dispose();
  });

  it("advertises frame timing and owns the worker when it can be created", () => {
    const terminate = vi.fn();
    stubFrameMetadataRuntimeSupport();
    vi.stubGlobal(
      "Worker",
      class {
        terminate = terminate;
      },
    );

    const prepared = prepareBrowserConnection(baseArgs);

    expect(prepared.frameTiming).toBe(true);
    // The pre-created worker is terminated on dispose when connect never took it.
    prepared.dispose();
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("enables frame timing without the legacy debugQuality flag", () => {
    const terminate = vi.fn();
    stubFrameMetadataRuntimeSupport();
    vi.stubGlobal(
      "Worker",
      class {
        terminate = terminate;
      },
    );

    const prepared = prepareBrowserConnection(baseArgs);

    expect(prepared.frameTiming).toBe(true);
    prepared.dispose();
  });

  it("leaves frame timing off when encoded transforms are unavailable", () => {
    const debug = vi.fn();
    const terminate = vi.fn();
    vi.stubGlobal(
      "Worker",
      class {
        terminate = terminate;
      },
    );

    const prepared = prepareBrowserConnection({ ...baseArgs, logger: { ...logger, debug } });

    expect(prepared.frameTiming).toBe(false);
    expect(terminate).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
    prepared.dispose();
  });

  it("leaves frame timing off when only sender encoded streams are available", () => {
    const debug = vi.fn();
    vi.stubGlobal("window", {
      navigator: { userAgent: "Mozilla/5.0 Firefox/140.0" },
      RTCRtpSender: { prototype: { createEncodedStreams() {} } },
    });

    const prepared = prepareBrowserConnection({ ...baseArgs, logger: { ...logger, debug } });

    expect(prepared.frameTiming).toBe(false);
    expect(debug).toHaveBeenCalled();
    prepared.dispose();
  });

  it("enables frame timing on script-transform browsers without insertable streams", () => {
    // Safari/Firefox ship RTCRtpScriptTransform and no createEncodedStreams.
    // Without this branch G2G would silently never run outside Chromium.
    const terminate = vi.fn();
    vi.stubGlobal("window", {
      navigator: {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      },
      RTCRtpScriptTransform: class {},
    });
    vi.stubGlobal(
      "Worker",
      class {
        terminate = terminate;
      },
    );

    const prepared = prepareBrowserConnection(baseArgs);

    expect(prepared.frameTiming).toBe(true);
    prepared.dispose();
  });

  it("hands the pre-created worker to the first connect and mints a fresh one per reconnect", () => {
    // The pre-created worker exists so `frameTiming` is only advertised when a
    // strip transform is guaranteed. If the handoff broke, the server would
    // append trailers the room could never strip.
    const created: object[] = [];
    stubFrameMetadataRuntimeSupport();
    vi.stubGlobal(
      "Worker",
      class {
        terminate = vi.fn();
        constructor() {
          created.push(this);
        }
      },
    );

    const prepared = prepareBrowserConnection(baseArgs);
    expect(prepared.frameTiming).toBe(true);
    expect(created).toHaveLength(1);

    const channelConfig = prepared.createMediaChannel({ logger }) as unknown as {
      config: { createFrameMetadataWorker?: () => Worker };
    };
    const takeWorker = channelConfig.config.createFrameMetadataWorker;
    expect(takeWorker).toBeTypeOf("function");

    // First connect consumes the pre-created worker; no new one is constructed.
    expect(takeWorker?.()).toBe(created[0]);
    expect(created).toHaveLength(1);

    // A reconnect gets a fresh worker — LiveKit terminates the old one with its room.
    const reconnectWorker = takeWorker?.();
    expect(created).toHaveLength(2);
    expect(reconnectWorker).toBe(created[1]);

    prepared.dispose();
  });

  it("does not rely on Chromium script transforms", () => {
    const debug = vi.fn();
    vi.stubGlobal("window", {
      navigator: { userAgent: "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36" },
      RTCRtpScriptTransform: class {},
    });

    const prepared = prepareBrowserConnection({ ...baseArgs, logger: { ...logger, debug } });

    expect(prepared.frameTiming).toBe(false);
    expect(debug).toHaveBeenCalled();
    prepared.dispose();
  });
});
