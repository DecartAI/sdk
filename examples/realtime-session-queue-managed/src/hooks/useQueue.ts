import { useEffect, useState, useSyncExternalStore } from "react";
import { QueueClient } from "./queue-client";

export type { GrantedSession, QueueState } from "./queue-client";

/**
 * Thin React binding for QueueClient — all queue logic lives in the
 * framework-free class; this hook only subscribes the component to it.
 * QueueClient's methods are stable references, so they can be passed as
 * props and used in effect dependencies directly.
 */
export function useQueue() {
  const [client] = useState(
    () =>
      new QueueClient({
        url: import.meta.env.VITE_QUEUE_URL ?? "http://localhost:8321",
        queueId: import.meta.env.VITE_QUEUE_ID ?? "test",
        publishableKey: import.meta.env.VITE_QUEUE_KEY ?? "pk_dev",
      }),
  );
  const status = useSyncExternalStore(client.subscribe, client.getState, client.getState);

  useEffect(() => () => client.dispose(), [client]);

  return {
    status,
    join: client.join,
    leave: client.leave,
    sessionEnded: client.sessionEnded,
    rejoin: client.rejoin,
  };
}
