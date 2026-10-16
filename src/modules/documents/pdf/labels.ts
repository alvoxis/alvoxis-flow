import { createTranslator } from "next-intl";
import { CATALOGS } from "@/i18n/catalogs";
import { type AppLocale } from "@/i18n/config";

/** Translator for document PDFs, independent of any request or UI locale. */
export function documentTranslator(locale: AppLocale) {
  return createTranslator({ locale, messages: CATALOGS[locale], namespace: "documentPdf" });
}
