import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/index.ts", "./src/express/middleware.ts", "./src/nextjs/middleware.ts"],
    platform: "neutral",
    dts: true,
    unbundle: true,
  },
]);
