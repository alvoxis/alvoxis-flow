import { type AppLocale, LOCALE_FORMAT_TAGS } from "@/i18n/config";
import { type CurrencyCode } from "@/lib/money";

/** Formatting for printed documents follows the DOCUMENT language, not the UI language. */
export function docDate(isoDate: string, locale: AppLocale): string {
  return new Intl.DateTimeFormat(LOCALE_FORMAT_TAGS[locale], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

export function docMoney(amount: string, currency: CurrencyCode, locale: AppLocale): string {
  return new Intl.NumberFormat(LOCALE_FORMAT_TAGS[locale], { style: "currency", currency }).format(
    amount as Intl.StringNumericLiteral,
  );
}

/** Unit prices may carry up to 4 decimals; show at least 2. */
export function docUnitPrice(amount: string, locale: AppLocale): string {
  return new Intl.NumberFormat(LOCALE_FORMAT_TAGS[locale], {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(amount as Intl.StringNumericLiteral);
}

export function docNumber(value: string, locale: AppLocale, maxFractionDigits = 4): string {
  return new Intl.NumberFormat(LOCALE_FORMAT_TAGS[locale], {
    maximumFractionDigits: maxFractionDigits,
  }).format(value as Intl.StringNumericLiteral);
}

/** Exchange rates keep the precision they were entered with, in the document's number format. */
export function docRate(rate: string, locale: AppLocale): string {
  const decimals = rate.split(".")[1]?.length ?? 0;
  return new Intl.NumberFormat(LOCALE_FORMAT_TAGS[locale], {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false,
  }).format(rate as Intl.StringNumericLiteral);
}
