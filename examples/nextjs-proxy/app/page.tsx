"use client";

import { createDecartClient, models } from "@decartai/sdk";
import { useState } from "react";

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    if (!prompt.trim()) return;

    setLoading(true);
    setError(null);
    setImageUrl(null);

    try {
      const client = createDecartClient({
        proxy: "/api/decart",
      });

      const blob = await client.process({
        model: models.image("lucy-pro-t2i"),
        prompt,
      });

      const url = URL.createObjectURL(blob);
      setImageUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate image");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="container">
      <h1>Decart SDK - Next.js Proxy Example</h1>
      <p>Generate images using the Decart SDK through the Next.js proxy</p>

      <div className="form">
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Enter a prompt (e.g., 'A beautiful sunset over mountains')"
          disabled={loading}
          onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
        />
        <button onClick={handleGenerate} disabled={loading || !prompt.trim()}>
          {loading ? "Generating..." : "Generate Image"}
        </button>
      </div>

      {error && <div className="error">Error: {error}</div>}

      {imageUrl && (
        <div className="result">
          <img src={imageUrl} alt="Generated" />
        </div>
      )}

      <style jsx>{`
        .container {
          max-width: 800px;
          margin: 0 auto;
          padding: 2rem;
        }

        h1 {
          margin-bottom: 0.5rem;
        }

        p {
          color: #666;
          margin-bottom: 2rem;
        }

        .form {
          display: flex;
          gap: 1rem;
          margin-bottom: 2rem;
        }

        input {
          flex: 1;
          padding: 0.75rem;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 1rem;
        }

        input:disabled {
          background-color: #f5f5f5;
          cursor: not-allowed;
        }

        button {
          padding: 0.75rem 1.5rem;
          background-color: #0070f3;
          color: white;
          border: none;
          border-radius: 4px;
          font-size: 1rem;
          cursor: pointer;
        }

        button:hover:not(:disabled) {
          background-color: #0051cc;
        }

        button:disabled {
          background-color: #ccc;
          cursor: not-allowed;
        }

        .error {
          padding: 1rem;
          background-color: #fee;
          color: #c33;
          border-radius: 4px;
          margin-bottom: 2rem;
        }

        .result {
          margin-top: 2rem;
        }

        .result img {
          max-width: 100%;
          border-radius: 8px;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
      `}</style>
    </main>
  );
}

