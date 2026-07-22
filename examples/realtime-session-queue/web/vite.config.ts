import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // The gatekeeper server; the app itself never talks to Decart's HTTP
      // API directly (only the realtime WebSocket, with an ephemeral token).
      "/api": process.env.GATEKEEPER_URL ?? "http://localhost:3000",
    },
  },
});
