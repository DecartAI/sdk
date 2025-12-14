import { createDecartClient, type DecartSDKError, models, type RealTimeClient } from "@decartai/sdk";
import { useEffect, useRef, useState } from "react";

interface VideoStreamProps {
  prompt: string;
}

export function VideoStream({ prompt }: VideoStreamProps) {
  const inputRef = useRef<HTMLVideoElement>(null);
  const outputRef = useRef<HTMLVideoElement>(null);
  const realtimeClientRef = useRef<RealTimeClient | null>(null);
  const [status, setStatus] = useState<string>("idle");

  useEffect(() => {
    let mounted = true;

    async function start() {
      try {
        const model = models.realtime("mirage_v2");

        setStatus("requesting camera...");
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            frameRate: model.fps,
            width: model.width,
            height: model.height,
          },
        });

        if (!mounted) return;

        if (inputRef.current) {
          inputRef.current.srcObject = stream;
        }

        setStatus("connecting...");

        const apiKey = import.meta.env.VITE_DECART_API_KEY;
        if (!apiKey) {
          throw new Error("DECART_API_KEY is not set");
        }

        const client = createDecartClient({
          apiKey,
        });

        const realtimeClient = await client.realtime.connect(stream, {
          model,
          onRemoteStream: (transformedStream: MediaStream) => {
            if (outputRef.current) {
              outputRef.current.srcObject = transformedStream;
            }
          },
          initialState: {
            prompt: { text: prompt, enhance: true },
          },
        });

        realtimeClientRef.current = realtimeClient;

        // Subscribe to events
        realtimeClient.on("connectionChange", (state) => {
          setStatus(state);
        });

        realtimeClient.on("error", (error: DecartSDKError) => {
          setStatus(`error: ${error.message}`);
        });
      } catch (error) {
        setStatus(`error: ${error}`);
      }
    }

    start();

    return () => {
      mounted = false;
      realtimeClientRef.current?.disconnect();
    };
  }, []);

  // Update prompt when it changes
  useEffect(() => {
    if (realtimeClientRef.current?.isConnected()) {
      realtimeClientRef.current.setPrompt(prompt, { enhance: true });
    }
  }, [prompt]);

  return (
    <div>
      <p>Status: {status}</p>
      <div style={{ display: "flex", gap: "1rem" }}>
        <div>
          <h3>Input</h3>
          <video ref={inputRef} autoPlay muted playsInline width={400} />
        </div>
        <div>
          <h3>Styled Output</h3>
          <video ref={outputRef} autoPlay playsInline width={400} />
        </div>
      </div>
    </div>
  );
}
