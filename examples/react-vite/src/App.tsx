import { useState } from "react";
import { VideoStream } from "./components/VideoStream";

function App() {
  const [prompt, setPrompt] = useState("anime style, vibrant colors");

  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui" }}>
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
    </div>
  );
}

export default App;
