import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __DECART_API_KEY__: JSON.stringify(process.env.DECART_API_KEY),
    __WEBRTC_BASE_URL__: JSON.stringify(process.env.WEBRTC_BASE_URL || "wss://slim-bit-invert.dev.localhost"),
  },
  test: {
    include: ["tests/e2e-turn-tcp.test.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
