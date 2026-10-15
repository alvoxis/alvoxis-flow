"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { LOCALE_ENDONYMS, LOCALES, type AppLocale } from "@/i18n/config";
import { usePathname, useRouter } from "@/i18n/navigation";

export function LocaleSwitcher() {
  const t = useTranslations("topbar");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      <span className="sr-only">{t("language")}</span>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
      >
        <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-9-9h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" />
      </svg>
      <select
        data-testid="locale-switcher"
        value={locale}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value as AppLocale;
          startTransition(() => router.replace(pathname, { locale: next }));
        }}
        className="rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm text-text"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {LOCALE_ENDONYMS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
