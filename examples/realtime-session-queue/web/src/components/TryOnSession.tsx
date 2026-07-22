import { createDecartClient, models, type RealTimeClient } from "@decartai/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GrantedSession } from "../hooks/useQueue";

interface TryOnSessionProps {
  session: GrantedSession;
  garment: File;
  /** Realtime connection established — the queue hook reports it to the server. */
  onConnected: () => void;
  /** Session over; a message means it ended with an error worth showing. */
  onEnded: (message?: string) => void;
  onLimitReached: () => void;
}

/**
 * The gate's whole job is done before this component mounts: it holds a
 * short-lived token and just connects. Decart enforces the session cap
 * (maxSessionDuration) server-side, so the countdown here is purely UX.
 */

/** Decart refuses over-limit connects with WS close code 1013 and reason
 *  "Session Limit Reached"; the SDK flattens both into the error message.
 *  This is the race the queue's requeue-at-head backstop recovers from. */
function isSessionLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b1013\b|session limit|concurrent session/i.test(message);
}

export function TryOnSession({ session, garment, onConnected, onEnded, onLimitReached }: TryOnSessionProps) {
  const inputRef = useRef<HTMLVideoElement>(null);
  const outputRef = useRef<HTMLVideoElement>(null);
  const realtimeClientRef = useRef<RealTimeClient | null>(null);
  const endedRef = useRef(false);
  const [phase, setPhase] = useState<string>("starting camera...");
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  // Keep the latest callbacks without retriggering the connect effect.
  const callbacksRef = useRef({ onConnected, onEnded, onLimitReached });
  callbacksRef.current = { onConnected, onEnded, onLimitReached };

  /** Single dedup'd exit — used by the End button and every session-end signal. */
  const endOnce = useCallback((message?: string) => {
    if (endedRef.current) return;
    endedRef.current = true;
    callbacksRef.current.onEnded(message);
  }, []);

  useEffect(() => {
    let mounted = true;
    let localStream: MediaStream | null = null;
    let countdown: ReturnType<typeof setInterval> | null = null;

    async function start() {
      // The server tells us which model our token is scoped to.
      const model = models.realtime(session.model as Parameters<typeof models.realtime>[0]);

      localStream = await navigator.mediaDevices.getUserMedia({
        video: { frameRate: model.fps, width: model.width, height: model.height },
      });
      if (!mounted) {
        // Unmounted while getUserMedia was pending — cleanup already ran.
        localStream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (inputRef.current) inputRef.current.srcObject = localStream;

      setPhase("connecting...");
      // The ephemeral token from the gatekeeper is the only credential the
      // app ever sees — the real API key never leaves the server.
      const client = createDecartClient({ apiKey: session.apiKey });
      const realtimeClient = await client.realtime.connect(localStream, {
        model,
        mirror: "auto",
        initialState: { image: garment },
        onRemoteStream: (transformed: MediaStream) => {
          if (outputRef.current) outputRef.current.srcObject = transformed;
        },
      });
      if (!mounted) {
        realtimeClient.disconnect();
        localStream.getTracks().forEach((track) => track.stop());
        return;
      }
      realtimeClientRef.current = realtimeClient;
      callbacksRef.current.onConnected();
      setPhase("live");

      const endsAt = Date.now() + session.maxSessionSeconds * 1000;
      setSecondsLeft(session.maxSessionSeconds);
      countdown = setInterval(() => {
        setSecondsLeft(Math.max(0, Math.round((endsAt - Date.now()) / 1000)));
      }, 1000);

      realtimeClient.on("connectionChange", (state) => {
        setPhase(state);
        if (state === "disconnected") endOnce();
      });
      // Fired when Decart ends generation, e.g. the maxSessionDuration cap.
      realtimeClient.on("generationEnded", () => endOnce());
    }

    start().catch((error) => {
      if (!mounted) return;
      if (isSessionLimitError(error)) {
        endedRef.current = true;
        callbacksRef.current.onLimitReached();
        return;
      }
      endOnce(error instanceof Error ? error.message : String(error));
    });

    return () => {
      mounted = false;
      if (countdown) clearInterval(countdown);
      realtimeClientRef.current?.disconnect();
      realtimeClientRef.current = null;
      localStream?.getTracks().forEach((track) => track.stop());
    };
  }, [session.apiKey, session.model, session.maxSessionSeconds, garment, endOnce]);

  return (
    <div className="session">
      <div className="session-header">
        <span className="status-pill">{phase}</span>
        {secondsLeft !== null && <span className="countdown">{secondsLeft}s left</span>}
        <button type="button" onClick={() => endOnce()}>
          End session
        </button>
      </div>
      <div className="videos">
        <div>
          <h3>Camera</h3>
          <video ref={inputRef} autoPlay muted playsInline />
        </div>
        <div>
          <h3>Try-on</h3>
          {/* biome-ignore lint/a11y/useMediaCaption: live generated video stream has no caption track */}
          <video ref={outputRef} autoPlay playsInline />
        </div>
      </div>
    </div>
  );
}
