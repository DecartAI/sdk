"use client";

import { useState } from "react";
import { VideoStream } from "../components/video-stream";

export default function Home() {
  const [prompt, setPrompt] = useState("anime style, vibrant colors");

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui" }}>
      <h1>Decart Realtime Demo</h1>

      <div style={{ marginBottom: "1rem" }}>
        <label>
          Style prompt:
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            style={{ marginLeft: "0.5rem", width: "300px", padding: "0.5rem" }}
          />
        </label>
      </div>

      <VideoStream prompt={prompt} />
    </main>
  );
}
