import { type AppLocale, DEFAULT_LOCALE, LOCALES } from "@/i18n/config";

/** Locale of a full pathname ("/lv/companies/…" → "lv"); the default for anything else. */
export function localeOfPath(pathname: string | null | undefined): AppLocale {
  const first = (pathname ?? "").split("/")[1] ?? "";
  return (LOCALES as readonly string[]).includes(first) ? (first as AppLocale) : DEFAULT_LOCALE;
}
