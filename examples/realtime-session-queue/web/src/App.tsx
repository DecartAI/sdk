import { useEffect, useMemo, useState } from "react";
import { TryOnSession } from "./components/TryOnSession";
import { useQueue } from "./hooks/useQueue";

// Stand-in for your real user identity (account id, device id, ...). The
// gatekeeper dedupes tickets by this, so one user holds one spot in line.
function getUserId(): string {
  const existing = localStorage.getItem("tryon-user-id");
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem("tryon-user-id", created);
  return created;
}

export function App() {
  const userId = useMemo(getUserId, []);
  const { status, join, leave, sessionConnected, endSession, reportLimitReached } = useQueue(userId);
  const [garment, setGarment] = useState<File | null>(null);
  const [garmentUrl, setGarmentUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!garment) {
      setGarmentUrl(null);
      return;
    }
    const url = URL.createObjectURL(garment);
    setGarmentUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [garment]);

  return (
    <main>
      <h1>Virtual try-on</h1>
      <p className="subtitle">Queued access to a capacity-limited realtime model</p>

      {status.phase === "idle" && (
        <section className="card">
          <label className="garment-picker">
            Pick a garment photo
            <input type="file" accept="image/*" onChange={(event) => setGarment(event.target.files?.[0] ?? null)} />
          </label>
          {garmentUrl && <img className="garment-preview" src={garmentUrl} alt="Selected garment" />}
          <button type="button" disabled={!garment} onClick={() => void join()}>
            Try it on
          </button>
        </section>
      )}

      {status.phase === "waiting" && (
        <section className="card">
          <div className="spinner" aria-hidden="true" />
          {status.position <= 1 ? (
            <p>You're next — hang tight...</p>
          ) : (
            <p>
              You're <strong>#{status.position}</strong> of {status.queueSize} in line
            </p>
          )}
          <button type="button" onClick={leave}>
            Leave the line
          </button>
        </section>
      )}

      {status.phase === "ready" && garment && (
        <TryOnSession
          session={status.session}
          garment={garment}
          onConnected={sessionConnected}
          onEnded={endSession}
          onLimitReached={reportLimitReached}
        />
      )}

      {status.phase === "error" && (
        <section className="card">
          <p className="error">{status.message}</p>
          <button type="button" onClick={() => endSession()}>
            Start over
          </button>
        </section>
      )}
    </main>
  );
}
