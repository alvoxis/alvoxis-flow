import { createTranslator } from "next-intl";
import { type AppLocale } from "@/i18n/config";
import en from "../../../../messages/en.json";
import et from "../../../../messages/et.json";
import lt from "../../../../messages/lt.json";
import lv from "../../../../messages/lv.json";
import ru from "../../../../messages/ru.json";

const catalogs = { en, ru, lv, lt, et } as const;

/** Translator for document PDFs, independent of any request or UI locale. */
export function documentTranslator(locale: AppLocale) {
  return createTranslator({ locale, messages: catalogs[locale], namespace: "documentPdf" });
}
