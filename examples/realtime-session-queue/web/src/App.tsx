import { useEffect, useState } from "react";
import garmentExampleUrl from "./assets/garment-example.webp";
import { TryOnSession } from "./components/TryOnSession";
import { useQueue } from "./hooks/useQueue";

export function App() {
  const { status, join, leave, sessionConnected, endSession, reportLimitReached } = useQueue();
  const [garment, setGarment] = useState<File | null>(null);

  // Preload the bundled sample so "Try it on" works with zero setup; picking
  // a file replaces it. The functional update keeps a user-chosen file if
  // the fetch resolves after they've already picked one.
  useEffect(() => {
    fetch(garmentExampleUrl)
      .then((response) => response.blob())
      .then((blob) => {
        const sample = new File([blob], "garment-example.webp", { type: "image/webp" });
        setGarment((current) => current ?? sample);
      })
      .catch(() => {});
  }, []);
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
            Garment photo (a sample is preloaded)
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
