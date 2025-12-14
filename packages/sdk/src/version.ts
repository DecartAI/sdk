// Version string injected at build time via tsdown
declare const __PACKAGE_VERSION__: string | undefined;

/**
 * The current version of the Decart SDK.
 * Injected at build time from package.json.
 * Falls back to '0.0.0-dev' in development.
 */
export const VERSION: string = typeof __PACKAGE_VERSION__ !== "undefined" ? __PACKAGE_VERSION__ : "0.0.0-dev";
