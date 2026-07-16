import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/index.ts", "./src/index.react-native.ts"],
    platform: "neutral",
    dts: true,
    unbundle: true,
    copy: [
      {
        from: "./node_modules/livekit-client/dist/livekit-client.fm.worker.js",
        to: "./dist/realtime/browser/frame-metadata-worker.js",
      },
    ],
    define: {
      __PACKAGE_VERSION__: JSON.stringify((await import("./package.json", { with: { type: "json" } })).default.version),
    },
  },
]);
