import {
  type ConnectionState,
  createDecartClient,
  type RealTimeSubscribeClient,
} from "@decartai/sdk";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { getClientToken } from "~/server/token";

export const Route = createFileRoute("/watch")({
  validateSearch: z.object({
    token: z.string(),
  }),
  component: WatchPage,
});

function WatchPage() {
  const { token } = Route.useSearch();
  const videoRef = useRef<HTMLVideoElement>(null);
  const clientRef = useRef<RealTimeSubscribeClient | null>(null);

  const [status, setStatus] = useState<ConnectionState | "idle">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      try {
        setStatus("connecting");

        const { apiKey } = await getClientToken();
        const client = createDecartClient({ apiKey });

        if (cancelled) return;

        const subscriber = await client.realtime.subscribe({
          token,
          onRemoteStream: (stream: MediaStream) => {
            if (videoRef.current) {
              videoRef.current.srcObject = stream;
            }
          },
        });

        if (cancelled) {
          subscriber.disconnect();
          return;
        }

        clientRef.current = subscriber;

        subscriber.on("connectionChange", (state) => {
          setStatus(state);
        });

        subscriber.on("error", (err) => {
          setError(err.message);
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus("idle");
        }
      }
    }

    connect();

    return () => {
      cancelled = true;
      clientRef.current?.disconnect();
    };
  }, [token]);

  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>Viewer</h1>
      <p style={{ color: "#666" }}>
        Watching a live-styled stream via subscribe token.
      </p>

      <p>
        Status: <strong>{status}</strong>
      </p>

      {error && <p style={{ color: "red" }}>Error: {error}</p>}

      <video ref={videoRef} autoPlay playsInline width={640} />
    </div>
  );
}
