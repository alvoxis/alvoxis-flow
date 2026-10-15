/**
 * Currencies supported at launch. Each document selects its own currency; there is
 * intentionally no company-wide base currency.
 */
export const SUPPORTED_CURRENCIES = ["EUR", "PLN"] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

/** ISO 4217 minor-unit exponents for supported currencies. */
export const CURRENCY_MINOR_UNITS: Record<CurrencyCode, number> = {
  EUR: 2,
  PLN: 2,
};

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}
