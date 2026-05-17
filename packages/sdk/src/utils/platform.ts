export type Platform = "mobile" | "desktop";

export function detectPlatform(): Platform {
  // biome-ignore lint/suspicious/noExplicitAny: runtime detection
  const g = globalThis as any;
  const ua: string = g?.navigator?.userAgent ?? "";
  if (/iPhone|iPad|iPod|Android|Mobi/i.test(ua)) return "mobile";
  return "desktop";
}

export function isDesktopSafari(): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: runtime detection
  const g = globalThis as any;
  const ua: string = g?.navigator?.userAgent ?? "";
  const platform: string = g?.navigator?.platform ?? "";
  const maxTouchPoints: number = g?.navigator?.maxTouchPoints ?? 0;

  if (!/^((?!chrome|chromium|crios|fxios|edg|firefox|opr|opera|android).)*safari/i.test(ua)) {
    return false;
  }
  if (/iPad|iPhone|iPod/.test(ua)) return false;
  if (platform === "MacIntel" && maxTouchPoints > 1) return false;
  return true;
}
