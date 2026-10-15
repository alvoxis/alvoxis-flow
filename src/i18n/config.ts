export const LOCALES = ["en", "ru", "lv", "lt", "et"] as const;
export type AppLocale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = "en";

/** Language names in their own language (endonyms); intentionally not translated. */
export const LOCALE_ENDONYMS: Record<AppLocale, string> = {
  en: "English",
  ru: "Русский",
  lv: "Latviešu",
  lt: "Lietuvių",
  et: "Eesti",
};

/** BCP 47 tags used for number/date formatting. */
export const LOCALE_FORMAT_TAGS: Record<AppLocale, string> = {
  en: "en-GB",
  ru: "ru-RU",
  lv: "lv-LV",
  lt: "lt-LT",
  et: "et-EE",
};
