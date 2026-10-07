"use client";

import { createDecartClient, type DecartSDKError, models, type RealTimeClient } from "@decartai/sdk";
import { useEffect, useRef, useState } from "react";

const model = models.realtime("lucy-restyle-2");

/**
 * Asks our backend for a fresh client token. The SDK calls this right before every connect and
 * reconnect, so the token is minted for that dial: it cannot have expired while the page sat open
 * or the user was deciding about camera permissions. (Client tokens live 60 s by default.)
 */
async function fetchClientToken(): Promise<string> {
  const response = await fetch("/api/realtime-token", { method: "POST" });
  if (!response.ok) throw new Error(`Token endpoint answered ${response.status}`);
  const { apiKey } = await response.json();
  return apiKey;
}

// One client for the page's lifetime. It holds no credential of its own; the provider supplies one per dial.
const client = createDecartClient({ apiKeyProvider: fetchClientToken });

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  const sdkError = error as Partial<DecartSDKError>;
  return sdkError?.code ? `${sdkError.code}: ${sdkError.message}` : String(error);
}

interface VideoStreamProps {
  prompt: string;
}

export function VideoStream({ prompt }: VideoStreamProps) {
  const inputRef = useRef<HTMLVideoElement>(null);
  const outputRef = useRef<HTMLVideoElement>(null);
  const realtimeClientRef = useRef<RealTimeClient | null>(null);
  const cameraRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [running, setRunning] = useState(false);

  function stop() {
    realtimeClientRef.current?.disconnect();
    realtimeClientRef.current = null;
    for (const track of cameraRef.current?.getTracks() ?? []) track.stop();
    cameraRef.current = null;
    setRunning(false);
    setStatus("idle");
  }

  async function start() {
    setRunning(true);
    try {
      // However long the page has been open, the token is minted only now, inside connect().
      setStatus("requesting camera...");
      const camera = await navigator.mediaDevices.getUserMedia({
        video: { frameRate: model.fps, width: model.width, height: model.height },
      });
      cameraRef.current = camera;
      if (inputRef.current) inputRef.current.srcObject = camera;

      setStatus("connecting...");
      const realtimeClient = await client.realtime.connect(camera, {
        model,
        onRemoteStream: (transformedStream) => {
          if (outputRef.current) outputRef.current.srcObject = transformedStream;
        },
        // "connected" | "generating" | "reconnecting" | "disconnected". A reconnect asks
        // fetchClientToken again, so it never dials with the token the session started with.
        onConnectionChange: setStatus,
        initialState: { prompt: { text: prompt, enhance: true } },
      });
      realtimeClientRef.current = realtimeClient;

      realtimeClient.on("error", (error) => setStatus(`error: ${describeError(error)}`));
    } catch (error) {
      setStatus(`error: ${describeError(error)}`);
      realtimeClientRef.current?.disconnect();
      realtimeClientRef.current = null;
      for (const track of cameraRef.current?.getTracks() ?? []) track.stop();
      cameraRef.current = null;
      setRunning(false);
    }
  }

  // Release the camera and the session when the component unmounts.
  useEffect(() => {
    return () => {
      realtimeClientRef.current?.disconnect();
      for (const track of cameraRef.current?.getTracks() ?? []) track.stop();
    };
  }, []);

  // Update the prompt on the running session when it changes.
  useEffect(() => {
    if (realtimeClientRef.current?.isConnected()) {
      realtimeClientRef.current.setPrompt(prompt, { enhance: true });
    }
  }, [prompt]);

  return (
    <div>
      <p>
        <button type="button" onClick={running ? stop : start}>
          {running ? "Stop" : "Start"}
        </button>
        <span style={{ marginLeft: "1rem" }}>Status: {status}</span>
      </p>
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
