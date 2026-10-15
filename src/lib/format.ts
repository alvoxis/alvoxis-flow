import { type CurrencyCode } from "@/lib/money";
import { type AppLocale, LOCALE_FORMAT_TAGS } from "@/i18n/config";

/**
 * Formats a decimal-string amount as currency without converting through a binary float
 * (Intl.NumberFormat accepts numeric strings with full precision).
 */
export function formatMoney(amount: string, currency: CurrencyCode, locale: AppLocale): string {
  return new Intl.NumberFormat(LOCALE_FORMAT_TAGS[locale], {
    style: "currency",
    currency,
    currencyDisplay: "symbol",
  }).format(amount as Intl.StringNumericLiteral);
}

export function formatDate(isoDate: string, locale: AppLocale): string {
  return new Intl.DateTimeFormat(LOCALE_FORMAT_TAGS[locale], {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}
