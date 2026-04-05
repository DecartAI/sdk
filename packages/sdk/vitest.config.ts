import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["tests/e2e-realtime.test.ts", "tests/e2e-turn-tcp.test.ts"],
  },
});
