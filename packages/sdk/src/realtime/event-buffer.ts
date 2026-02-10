import mitt, { type Emitter } from "mitt";

type EventRecord = Record<string, unknown>;

type BufferedEntry<E extends EventRecord> = {
  event: keyof E;
  data: E[keyof E];
};

type EventBuffer<E extends EventRecord> = {
  emitter: Emitter<E>;
  emitOrBuffer: <K extends keyof E>(event: K, data: E[K]) => void;
  flush: () => void;
  stop: () => void;
};

export function createEventBuffer<E extends EventRecord>(): EventBuffer<E> {
  const emitter = mitt<E>();
  const buffer: BufferedEntry<E>[] = [];
  let buffering = true;

  const emitOrBuffer = <K extends keyof E>(event: K, data: E[K]) => {
    if (buffering) {
      buffer.push({ event, data: data as E[keyof E] });
    } else {
      emitter.emit(event, data);
    }
  };

  const flush = () => {
    setTimeout(() => {
      buffering = false;
      for (const { event, data } of buffer) {
        (emitter.emit as (type: keyof E, data: E[keyof E]) => void)(event, data);
      }
      buffer.length = 0;
    }, 0);
  };

  const stop = () => {
    buffering = false;
    buffer.length = 0;
  };

  return { emitter, emitOrBuffer, flush, stop };
}
