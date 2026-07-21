import packageJson from "../package.json" with { type: "json" };

/**
 * The current version of the Decart SDK, read from package.json.
 *
 * Read as a real module binding rather than a build-time `define` replacement:
 * `define` is rejected by the pinned tsdown/rolldown ("Invalid key: define"),
 * so a magic-token approach silently fell back to a placeholder and shipped the
 * wrong version in the User-Agent. The bundler tree-shakes this import down to
 * just the version string at build time.
 */
export const VERSION: string = packageJson.version;
