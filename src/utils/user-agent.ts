import { VERSION } from "../version";

/**
 * Detects the current runtime environment and returns a formatted string.
 * Includes version for server runtimes (Node.js, Bun, Deno).
 * Returns just "Browser" for browser environments (privacy + simplicity).
 *
 * @returns Runtime environment string
 * @example
 * // Node.js
 * getRuntimeEnvironment() // => "Node.js/v18.17.0"
 *
 * @example
 * // Browser
 * getRuntimeEnvironment() // => "Browser"
 *
 * @example
 * // Bun
 * getRuntimeEnvironment() // => "Bun/1.0.0"
 */
export function getRuntimeEnvironment(): string {
	// Browser - no version for privacy
	if (typeof window !== "undefined") {
		return "runtime/browser";
	}

	// Node.js - include version
	if (typeof process !== "undefined" && process.versions?.node) {
		return `runtime/node.js/${process.version}`;
	}

	// Bun - include version
	if (typeof process !== "undefined" && process.versions?.bun) {
		return `runtime/bun/${process.versions.bun}`;
	}

	// Deno - include version
	// @ts-expect-error - Deno is a global in Deno runtime
	if (typeof Deno !== "undefined" && typeof Deno.version?.deno === "string") {
		// @ts-expect-error - Deno is a global in Deno runtime
		return `runtime/deno/${Deno.version.deno}`;
	}

	return "runtime/unknown";
}

/**
 * Builds the User-Agent string for the SDK.
 * Format: decart-js-sdk/{version} lang/js {runtime}
 *
 * @returns Complete User-Agent string
 * @example
 * buildUserAgent() // => "decart-js-sdk/0.0.7 lang/js runtime/node.js/v18.17.0"
 * buildUserAgent() // => "decart-js-sdk/0.0.7 lang/js runtime/browser"
 */
export function buildUserAgent(): string {
	return `decart-js-sdk/${VERSION} lang/js ${getRuntimeEnvironment()}`;
}
