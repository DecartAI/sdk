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

describe("prepareBrowserConnection frame-timing gating", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not advertise frame timing when the frame-metadata worker cannot be created", () => {
    // The server appends a packet trailer to every frame once frame timing is
    // advertised; without a strip worker the decoder chokes. So a worker that
    // can't be constructed (e.g. blocked by CSP) must keep frame timing off.
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("worker blocked");
        }
      },
    );
    const warn = vi.fn();

    const prepared = prepareBrowserConnection({ ...baseArgs, logger: { ...logger, warn }, debugQuality: true });

    expect(prepared.frameTiming).toBe(false);
    expect(warn).toHaveBeenCalled();
    prepared.dispose();
  });

  it("advertises frame timing and owns the worker when it can be created", () => {
    const terminate = vi.fn();
    vi.stubGlobal(
      "Worker",
      class {
        terminate = terminate;
      },
    );

    const prepared = prepareBrowserConnection({ ...baseArgs, debugQuality: true });

    expect(prepared.frameTiming).toBe(true);
    // The pre-created worker is terminated on dispose when connect never took it.
    prepared.dispose();
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("leaves frame timing off when debugQuality is disabled", () => {
    const prepared = prepareBrowserConnection({ ...baseArgs, debugQuality: false });

    expect(prepared.frameTiming).toBe(false);
    prepared.dispose();
  });
});
