import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// No proxy on purpose: the app talks to Decart's managed queue API directly
// (it sends CORS-safe requests with the publishable queue key). There is no
// customer backend anywhere in this example.
export default defineConfig({
  plugins: [react()],
});
