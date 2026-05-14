import type { Logger } from "../utils/logger";
import type { InitialState } from "./types";

type RemoteStreamExposureConfig = {
  logger: Logger;
  expose: (stream: MediaStream) => void;
};

export type RemoteStreamExposureAttempt = {
  waitForReadiness: (initialStateAck: Promise<void>) => Promise<void>;
};

export class RemoteStreamExposure {
  private attemptId = 0;
  private waitingForInitialState = false;
  private bufferedStream: MediaStream | null = null;

  constructor(private readonly config: RemoteStreamExposureConfig) {}

  startAttempt(initialState: InitialState | undefined): RemoteStreamExposureAttempt {
    const attemptId = ++this.attemptId;
    this.waitingForInitialState = hasCallerProvidedInitialState(initialState);
    this.bufferedStream = null;

    return {
      waitForReadiness: async (initialStateAck) => {
        if (!this.waitingForInitialState) return;
        await initialStateAck;
        if (this.attemptId !== attemptId) return;
        this.releaseBufferedStream();
      },
    };
  }

  accept(stream: MediaStream): void {
    // TEMPORARILY DISABLED for demo: do not await caller initial-state ack
    // before exposing the remote stream. Restore the buffering branch (and
    // the matching commented-out tests in tests/realtime.unit.test.ts) to
    // re-enable the gate.
    this.config.expose(stream);
  }

  reset(): void {
    this.attemptId++;
    this.waitingForInitialState = false;
    this.bufferedStream = null;
  }

  private releaseBufferedStream(): void {
    this.waitingForInitialState = false;
    if (!this.bufferedStream) return;

    this.config.logger.debug("releasing buffered remoteStream after ack");
    const stream = this.bufferedStream;
    this.bufferedStream = null;
    this.config.expose(stream);
  }
}

export function hasCallerProvidedInitialState(state: InitialState | undefined): boolean {
  if (!state) return false;
  return (state.image !== undefined && state.image !== null) || (state.prompt !== undefined && state.prompt !== null);
}
