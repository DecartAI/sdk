export const readEnv = (env: string): string | undefined => {
	// biome-ignore lint/suspicious/noExplicitAny: allow any for runtime detection
	const globalThisAny = globalThis as any;

	// Covers: Node.js, Bun, Lambda, Vercel Edge, Cloudflare (with compat flags)
	if (typeof globalThisAny.process !== "undefined") {
		return globalThisAny.process.env?.[env]?.trim();
	}

	// Covers: Deno
	if (typeof globalThisAny.Deno !== "undefined") {
		return globalThisAny.Deno.env?.get?.(env)?.trim();
	}

	return undefined;
};
