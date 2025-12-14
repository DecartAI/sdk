import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/index.ts"],
    platform: "neutral",
    dts: true,
    unbundle: true,
    define: {
      __PACKAGE_VERSION__: JSON.stringify((await import("./package.json", { with: { type: "json" } })).default.version),
    },
  },
]);
