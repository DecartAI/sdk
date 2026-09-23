import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUpstreamUrl } from "../src/proxy-session.js";

const base = { decartApiKey: "key+with~chars", model: "lucy-2.1", decartBaseUrl: "wss://api3.decart.ai" };

test("no optional params: upstream URL is byte-identical to the original construction", () => {
  assert.equal(buildUpstreamUrl(base), "wss://api3.decart.ai/v1/stream?api_key=key+with~chars&model=lucy-2.1");
});

test("speed is appended verbatim after model when provided", () => {
  assert.equal(
    buildUpstreamUrl({ ...base, model: "lucy-2.5", speed: "fast" }),
    "wss://api3.decart.ai/v1/stream?api_key=key+with~chars&model=lucy-2.5&speed=fast",
  );
});

test("resolution and speed are both forwarded, resolution first", () => {
  assert.equal(
    buildUpstreamUrl({ ...base, model: "lucy-2.5", resolution: "1080p", speed: "fast" }),
    "wss://api3.decart.ai/v1/stream?api_key=key+with~chars&model=lucy-2.5&resolution=1080p&speed=fast",
  );
});

test("optional param values are URL-encoded", () => {
  assert.equal(
    buildUpstreamUrl({ ...base, speed: "fa st&x=1" }),
    "wss://api3.decart.ai/v1/stream?api_key=key+with~chars&model=lucy-2.1&speed=fa%20st%26x%3D1",
  );
});
