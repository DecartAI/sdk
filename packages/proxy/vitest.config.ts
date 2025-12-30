import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false, // We are importing describe/it/expect
  },
});
