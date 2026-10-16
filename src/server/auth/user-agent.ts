/** Small, dependency-free user-agent summary for the session list ("Chrome on macOS"). */
export interface DeviceSummary {
  browser: string | null;
  os: string | null;
  mobile: boolean;
}

export function describeUserAgent(ua: string | null | undefined): DeviceSummary {
  if (!ua) return { browser: null, os: null, mobile: false };
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows NT/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  return { browser, os, mobile: /Mobile|iPhone|Android/.test(ua) };
}

export function deviceLabel(ua: string | null | undefined, fallback: string): string {
  const d = describeUserAgent(ua);
  if (!d.browser && !d.os) return fallback;
  return [d.browser, d.os].filter(Boolean).join(" · ");
}
