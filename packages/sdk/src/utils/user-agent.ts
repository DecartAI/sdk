import { VERSION } from "../version";

export function getRuntimeEnvironment(
  // biome-ignore lint/suspicious/noExplicitAny: allow any for runtime detection
  globalThisAny = globalThis as any,
): string {
  // Browsers
  if (globalThisAny.window) {
    return "runtime/browser";
  }

  // Cloudflare Workers / Deno / Bun / Node.js >= 21.1
  if (globalThisAny.navigator?.userAgent) {
    return `runtime/${globalThisAny.navigator.userAgent.toLowerCase()}`;
  }

  // Nodes.js < 21.1
  if (globalThisAny.process?.versions?.node) {
    return `runtime/node.js/${globalThisAny.process.version.substring(0)}`;
  }

  if (globalThisAny.EdgeRuntime) {
    return "runtime/vercel-edge";
  }

  return "runtime/unknown";
}

/**
 * Builds the User-Agent string for the SDK.
 * Format: decart-js-sdk/{version} lang/js {integration} {runtime}
 *
 * @param integration - Optional integration identifier (e.g., "vercel-ai-sdk/3.0.0")
 * @param globalThisAny - The global object (defaults to globalThis). Can be mocked for testing.
 * @returns Complete User-Agent string
 * @example
 * buildUserAgent() // => "decart-js-sdk/0.0.7 lang/js runtime/node.js/v18.17.0"
 * buildUserAgent("vercel-ai-sdk/3.0.0") // => "decart-js-sdk/0.0.7 lang/js vercel-ai-sdk/3.0.0 runtime/node.js/v18.17.0"
 */
export function buildUserAgent(
  integration?: string,
  // biome-ignore lint/suspicious/noExplicitAny: allow any for runtime detection
  globalThisAny: any = globalThis,
): string {
  const parts = [
    `decart-js-sdk/${VERSION}`,
    "lang/js",
    ...(integration ? [integration] : []),
    getRuntimeEnvironment(globalThisAny),
  ];

  return parts.join(" ");
}
