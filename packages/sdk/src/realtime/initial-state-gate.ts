import type { InitialState } from "./types";

export type InitialStateGateAttempt = {
  waitForReadiness: (initialStateAck: Promise<void>) => Promise<boolean>;
};

export class InitialStateGate {
  private attemptId = 0;

  startAttempt(initialState: InitialState | undefined): InitialStateGateAttempt {
    const attemptId = ++this.attemptId;
    const shouldWait = hasCallerProvidedInitialState(initialState);

    return {
      waitForReadiness: async (initialStateAck) => {
        if (shouldWait) {
          await initialStateAck;
        }
        return this.attemptId === attemptId;
      },
    };
  }

  reset(): void {
    this.attemptId++;
  }
}

export function hasCallerProvidedInitialState(state: InitialState | undefined): boolean {
  if (!state) return false;
  return (state.image !== undefined && state.image !== null) || (state.prompt !== undefined && state.prompt !== null);
}
