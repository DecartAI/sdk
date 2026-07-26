import { createDecartClient, models, type RealTimeClient } from "@decartai/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GrantedSession } from "../hooks/useQueue";

interface TryOnSessionProps {
  session: GrantedSession;
  garment: File;
  /** Session over; a message means it ended with an error worth showing. */
  onEnded: (message?: string) => void;
  /** Decart refused the connect (rare race) — the app just rejoins the line. */
  onRefused: () => void;
}

/**
 * The queue's whole job is done before this component mounts: it holds a
 * short-lived token and just connects. Decart enforces the session cap
 * (maxSessionDuration) server-side, so the countdown here is purely UX.
 */
export function TryOnSession({ session, garment, onEnded, onRefused }: TryOnSessionProps) {
  const inputRef = useRef<HTMLVideoElement>(null);
  const outputRef = useRef<HTMLVideoElement>(null);
  const realtimeClientRef = useRef<RealTimeClient | null>(null);
  const endedRef = useRef(false);
  const [phase, setPhase] = useState<string>("starting camera...");
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  // Keep the latest callbacks without retriggering the connect effect.
  const callbacksRef = useRef({ onEnded, onRefused });
  callbacksRef.current = { onEnded, onRefused };

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
      // The queue tells us which model our token is scoped to.
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
      // The short-lived token from the queue is the only credential the app
      // ever sees.
      const client = createDecartClient({ apiKey: session.apiKey });
      let realtimeClient: RealTimeClient;
      try {
        realtimeClient = await client.realtime.connect(localStream, {
          model,
          mirror: "auto",
          initialState: { image: garment },
          onRemoteStream: (transformed: MediaStream) => {
            if (outputRef.current) outputRef.current.srcObject = transformed;
          },
        });
      } catch {
        // The managed queue's one recovery rule: a refused connect means
        // rejoin — a fresh ticket, decided against the live capacity.
        if (mounted && !endedRef.current) {
          endedRef.current = true;
          callbacksRef.current.onRefused();
        }
        return;
      }
      if (!mounted) {
        realtimeClient.disconnect();
        localStream.getTracks().forEach((track) => track.stop());
        return;
      }
      realtimeClientRef.current = realtimeClient;
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
      // Camera/permission failures land here (connect failures are handled
      // above); show them instead of looping through the queue.
      if (!mounted) return;
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
