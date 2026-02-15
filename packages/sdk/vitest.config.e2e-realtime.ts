import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __DECART_API_KEY__: JSON.stringify(process.env.DECART_API_KEY),
  },
  test: {
    include: ["tests/e2e-realtime.test.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
