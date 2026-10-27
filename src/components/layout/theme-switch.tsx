"use client";

import { useTranslations } from "next-intl";

export const THEME_COOKIE = "alvoxis-theme";

/**
 * Runs before the first paint (inline, first in <body>): applies the saved theme so the page never
 * flashes the wrong colours. Dark is the default. The choice is a first-party preference cookie
 * (read only by this script, never by the server): a synchronous localStorage read here could
 * stall the parser long enough for cached page scripts to start hydrating a half-parsed document.
 */
export const THEME_BOOT_SCRIPT = `try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=(light|dark)(?:;|$)/);if(m)document.documentElement.dataset.theme=m[1]}catch(e){}`;

/**
 * Light/dark switch. Both icons are rendered and CSS shows the right one, so the server and the
 * browser render the same markup (no hydration mismatch). The choice is stored per browser only.
 */
export function ThemeSwitch({ className = "inline-flex" }: { className?: string }) {
  const t = useTranslations("topbar");
  return (
    <button
      type="button"
      data-testid="theme-switch"
      aria-label={t("theme")}
      title={t("theme")}
      onClick={() => {
        const root = document.documentElement;
        const next = root.dataset.theme === "light" ? "dark" : "light";
        root.dataset.theme = next;
        document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax${
          location.protocol === "https:" ? "; secure" : ""
        }`;
      }}
      className={`${className} size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted transition-colors hover:text-text active:scale-95`}
    >
      {/* Sun: offered while dark. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="theme-icon-dark size-4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
      >
        <circle cx="12" cy="12" r="4" />
        <path
          d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
          strokeLinecap="round"
        />
      </svg>
      {/* Moon: offered while light. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="theme-icon-light size-4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
      >
        <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
