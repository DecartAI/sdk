export type Platform = "mobile" | "desktop";

export function detectPlatform(): Platform {
  // biome-ignore lint/suspicious/noExplicitAny: runtime detection
  const g = globalThis as any;
  const ua: string = g?.navigator?.userAgent ?? "";
  if (/iPhone|iPad|iPod|Android|Mobi/i.test(ua)) return "mobile";
  return "desktop";
}
