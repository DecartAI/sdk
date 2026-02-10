import { type ConnectionState, createDecartClient, models, type RealTimeClient } from "@decartai/sdk";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { getClientToken } from "~/server/token";

export const Route = createFileRoute("/")({
  component: ProducerPage,
});

function ProducerPage() {
  const inputRef = useRef<HTMLVideoElement>(null);
  const outputRef = useRef<HTMLVideoElement>(null);
  const clientRef = useRef<RealTimeClient | null>(null);

  const [status, setStatus] = useState<ConnectionState | "idle" | "requesting-camera">("idle");
  const [prompt, setPrompt] = useState("cinematic, film grain, moody lighting");
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    try {
      const model = models.realtime("lucy_2_rt");

      setStatus("requesting-camera");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          frameRate: model.fps,
          width: model.width,
          height: model.height,
        },
      });

      if (inputRef.current) {
        inputRef.current.srcObject = stream;
      }

      setStatus("connecting");

      const { apiKey } = await getClientToken();
      const client = createDecartClient({ apiKey });

      const realtimeClient = await client.realtime.connect(stream, {
        model,
        onRemoteStream: (remoteStream: MediaStream) => {
          if (outputRef.current) {
            outputRef.current.srcObject = remoteStream;
          }
        },
        initialState: {
          prompt: { text: prompt, enhance: true },
        },
      });

      clientRef.current = realtimeClient;

      realtimeClient.on("connectionChange", (state) => {
        setStatus(state);

        if ((state === "connected" || state === "generating") && realtimeClient.subscribeToken) {
          const url = new URL("/watch", window.location.origin);
          url.searchParams.set("token", realtimeClient.subscribeToken);
          setShareUrl(url.toString());
        }
      });

      realtimeClient.on("error", (err) => {
        setError(err.message);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("idle");
    }
  }, [prompt]);

  useEffect(() => {
    return () => {
      clientRef.current?.disconnect();
    };
  }, []);

  const updatePrompt = () => {
    if (clientRef.current?.isConnected()) {
      clientRef.current.setPrompt(prompt, { enhance: true });
    }
  };

  const copyShareUrl = () => {
    if (shareUrl) {
      navigator.clipboard.writeText(shareUrl);
    }
  };

  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>Producer</h1>
      <p style={{ color: "#666" }}>
        Streams your camera through <code>lucy_2_rt</code> and generates a subscribe link for viewers.
      </p>

      {status === "idle" && (
        <button type="button" onClick={start} style={buttonStyle}>
          Start Streaming
        </button>
      )}

      {error && <p style={{ color: "red" }}>Error: {error}</p>}

      <p>
        Status: <strong>{status}</strong>
      </p>

      <div style={{ marginBottom: "1rem", display: "flex", gap: "0.5rem" }}>
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && updatePrompt()}
          style={{ padding: "0.5rem", width: "350px" }}
          placeholder="Style prompt..."
        />
        <button type="button" onClick={updatePrompt} style={buttonStyle}>
          Update
        </button>
      </div>

      {shareUrl && (
        <div
          style={{
            padding: "0.75rem 1rem",
            background: "#f0f9f0",
            border: "1px solid #b5e2b5",
            borderRadius: 6,
            marginBottom: "1rem",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <span style={{ flex: 1, wordBreak: "break-all", fontSize: "0.85rem" }}>{shareUrl}</span>
          <button type="button" onClick={copyShareUrl} style={buttonStyle}>
            Copy
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <h3>Camera Input</h3>
          <video ref={inputRef} autoPlay muted playsInline width={480} />
        </div>
        <div>
          <h3>Styled Output</h3>
          <video ref={outputRef} autoPlay playsInline width={480} />
        </div>
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  cursor: "pointer",
};
