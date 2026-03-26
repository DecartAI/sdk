"use client";

import { PROXY_ROUTE } from "@decartai/proxy/nextjs";
import { createDecartClient, models } from "@decartai/sdk";
import Image from "next/image";
import { useState } from "react";
import styles from "./page.module.css";

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [sourceImage, setSourceImage] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    if (!prompt.trim() || !sourceImage) return;

    setLoading(true);
    setError(null);
    setImageUrl(null);

    try {
      const client = createDecartClient({ proxy: PROXY_ROUTE });
      const blob = await client.process({
        model: models.image("lucy-pro-i2i"),
        prompt,
        data: sourceImage,
      });
      const url = URL.createObjectURL(blob);
      setImageUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to edit image");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className={styles.container}>
      <h1 className={styles.title}>Decart SDK - Next.js Proxy Example</h1>
      <p className={styles.description}>Edit an image using the Decart SDK through the Next.js proxy</p>

      <div className={styles.form}>
        <input
          type="text"
          className={styles.input}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Enter an edit prompt (e.g., 'Turn this into a watercolor painting')"
          disabled={loading}
          onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
        />
        <input
          type="file"
          className={styles.input}
          accept="image/*"
          disabled={loading}
          onChange={(e) => setSourceImage(e.target.files?.[0] ?? null)}
        />
        <button
          className={styles.button}
          onClick={handleGenerate}
          disabled={loading || !prompt.trim() || !sourceImage}
          type="button"
        >
          {loading ? "Editing..." : "Edit Image"}
        </button>
      </div>

      {error && <div className={styles.error}>Error: {error}</div>}

      {imageUrl && (
        <div className={styles.result}>
          <Image
            src={imageUrl}
            alt="Edited"
            sizes="100vw"
            width={800}
            height={450}
            style={{
              width: "100%",
              height: "auto",
            }}
          />
        </div>
      )}
    </main>
  );
}
