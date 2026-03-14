import { useState } from "react";
import { VideoStream } from "./components/VideoStream";

function App() {
  const [prompt, setPrompt] = useState("anime style, vibrant colors");
  const [transport, setTransport] = useState<"webrtc" | "ivs">("webrtc");

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

      <div style={{ marginBottom: "1rem" }}>
        <label>
          Transport:
          <select
            value={transport}
            onChange={(e) => setTransport(e.target.value as "webrtc" | "ivs")}
            style={{ marginLeft: "0.5rem", padding: "0.5rem" }}
          >
            <option value="webrtc">WebRTC</option>
            <option value="ivs">IVS</option>
          </select>
        </label>
      </div>

      <VideoStream key={transport} prompt={prompt} transport={transport} />
    </div>
  );
}

export default App;
