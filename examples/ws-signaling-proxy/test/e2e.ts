import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import WebSocket from "ws";

const DECART_API_KEY = process.env.DECART_API_KEY;

// 512x512 black PNG
const TEST_IMAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAADEUlEQVR4nO3BgQAAAADDoPlTX+EAVQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMBvArQAAVkUTe8AAAAASUVORK5CYII=";

test("e2e: signaling flow through proxy", { timeout: 30_000 }, async (t) => {
  if (!DECART_API_KEY) {
    throw new Error("DECART_API_KEY is required");
  }

  const port = 10000 + Math.floor(Math.random() * 50000);

  // Start proxy as child process
  const server = spawn("node", ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      DECART_API_KEY: DECART_API_KEY as string,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
  t.after(() => server.kill());

  await new Promise<void>((resolve, reject) => {
    server.stdout?.on("data", (d: Buffer) => {
      process.stdout.write(d);
      if (d.toString().includes("listening on")) resolve();
    });
    server.on("error", reject);
  });

  // Connect client
  const ws = new WebSocket(`ws://localhost:${port}/v1/stream?model=lucy_2_rt`);
  await new Promise<void>((r, e) => {
    ws.on("open", r);
    ws.on("error", e);
  });
  t.after(() => ws.close());

  // Collect messages, resolve waiters by type
  // biome-ignore lint/suspicious/noExplicitAny: test code
  const received: any[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: test code
  const waiters = new Map<string, (msg: any) => void>();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    received.push(msg);
    waiters.get(msg.type)?.(msg);
    waiters.delete(msg.type);
  });

  // biome-ignore lint/suspicious/noExplicitAny: test code
  function waitFor(type: string, ms = 15_000): Promise<any> {
    const found = received.find((m) => m.type === type);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${type}"`)), ms);
      waiters.set(type, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  // set_image → set_image_ack
  ws.send(
    JSON.stringify({
      type: "set_image",
      image_data: TEST_IMAGE,
      prompt: "Test prompt",
      enhance_prompt: false,
    }),
  );
  assert.equal((await waitFor("set_image_ack")).success, true);
  console.log("  ✓ set_image_ack");

  // prompt → prompt_ack
  ws.send(
    JSON.stringify({
      type: "prompt",
      prompt: "Cyberpunk neon city",
      enhance_prompt: true,
    }),
  );
  assert.equal((await waitFor("prompt_ack")).success, true);
  console.log("  ✓ prompt_ack");
});
