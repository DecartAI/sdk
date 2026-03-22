/**
 * Type declarations for the Insertable Streams API (Chrome 94+).
 * https://developer.mozilla.org/en-US/docs/Web/API/Insertable_Streams_for_MediaStreamTrack_API
 */

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
}

declare class MediaStreamTrackProcessor {
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<VideoFrame>;
}

interface MediaStreamTrackGeneratorInit {
  kind: "audio" | "video";
}

declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: MediaStreamTrackGeneratorInit);
  readonly writable: WritableStream<VideoFrame>;
}
