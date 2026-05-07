import { describe, expect, it } from "vitest";
import {
  createMirroredStream,
  isMediaStreamTrackProcessorSupported,
  shouldMirrorTrack,
} from "../src/realtime/mirror-stream.js";

function fakeTrack(overrides: Partial<MediaStreamTrack> & { settings?: MediaTrackSettings }): MediaStreamTrack {
  const settings = overrides.settings ?? {};
  return {
    kind: "video",
    getSettings: () => settings,
    ...overrides,
  } as unknown as MediaStreamTrack;
}

describe("shouldMirrorTrack", () => {
  it("returns true for a front-facing video track", () => {
    expect(shouldMirrorTrack(fakeTrack({ settings: { facingMode: "user" } }))).toBe(true);
  });

  it("returns false for a back-facing video track", () => {
    expect(shouldMirrorTrack(fakeTrack({ settings: { facingMode: "environment" } }))).toBe(false);
  });

  it("returns false when facingMode is unreported", () => {
    expect(shouldMirrorTrack(fakeTrack({ settings: {} }))).toBe(false);
  });

  it("returns false for audio tracks", () => {
    expect(shouldMirrorTrack(fakeTrack({ kind: "audio", settings: { facingMode: "user" } }))).toBe(false);
  });

  it("returns false when getSettings throws", () => {
    const track = {
      kind: "video",
      getSettings: () => {
        throw new Error("not supported");
      },
    } as unknown as MediaStreamTrack;
    expect(shouldMirrorTrack(track)).toBe(false);
  });
});

describe("isMediaStreamTrackProcessorSupported", () => {
  it("returns false in node", () => {
    expect(isMediaStreamTrackProcessorSupported()).toBe(false);
  });
});

describe("createMirroredStream", () => {
  it("passes audio-only streams through as a no-op", () => {
    const audioTrack = fakeTrack({ kind: "audio", settings: {} });
    const inputStream = {
      getVideoTracks: () => [],
      getAudioTracks: () => [audioTrack],
    } as unknown as MediaStream;

    const result = createMirroredStream(inputStream, { fps: 25 });
    expect(result.stream).toBe(inputStream);
    expect(() => result.dispose()).not.toThrow();
  });
});
