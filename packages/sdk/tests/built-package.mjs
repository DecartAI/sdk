import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

for (const name of ["File", "Blob", "ReadableStream", "WritableStream", "TransformStream", "DOMException"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
}

const browserSdk = await import("../dist/index.js");
assert.equal(browserSdk.models.realtime("lucy-2.5").name, "lucy-2.5");
assert.doesNotThrow(() => browserSdk.createDecartClient({ apiKey: "test" }));

const reactNativeCheck = spawnSync(
  process.execPath,
  [
    "--conditions=react-native",
    "--input-type=module",
    "--eval",
    `
      const sdk = await import("@decartai/sdk");
      const client = sdk.createDecartClient({ apiKey: "test" });
      try {
        await client.realtime.connect(null, {
          model: sdk.models.realtime("lucy-2.5"),
          onRemoteStream() {},
        });
        process.exitCode = 2;
      } catch (error) {
        if (error?.code !== sdk.ERROR_CODES.REACT_NATIVE_SETUP_REQUIRED) throw error;
      }
    `,
  ],
  { cwd: new URL("..", import.meta.url), encoding: "utf8" },
);

assert.equal(reactNativeCheck.status, 0, reactNativeCheck.stderr || reactNativeCheck.stdout);
