import Decimal from "decimal.js";
import { type CurrencyCode } from "./currency";
import { Money, RoundingMode } from "./money";

/**
 * Where an exchange rate came from. A reference source (e.g. a central bank feed) will be
 * integrated in a later stage; until then only manually entered rates can exist.
 */
export type ExchangeRateSource =
  | { kind: "reference"; provider: string; retrievedAt: string }
  | { kind: "manual"; enteredByUserId: string; reason?: string };

/**
 * A rate with provenance. Approved documents store a snapshot of this object and must
 * never be silently recalculated when newer rates arrive.
 */
export interface ExchangeRate {
  from: CurrencyCode;
  to: CurrencyCode;
  /** Units of `to` per one unit of `from`, as a decimal string. */
  rate: string;
  /** Calendar date (YYYY-MM-DD) the rate is valid for. */
  rateDate: string;
  source: ExchangeRateSource;
}

const RATE = /^\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertValidExchangeRate(rate: ExchangeRate): void {
  if (rate.from === rate.to)
    throw new Error("Exchange rate must convert between different currencies");
  if (!RATE.test(rate.rate) || new Decimal(rate.rate).lte(0)) {
    throw new Error(`Exchange rate must be a positive decimal string, got "${rate.rate}"`);
  }
  if (!DATE.test(rate.rateDate)) throw new Error(`Invalid rate date "${rate.rateDate}"`);
}

/** Convert using an explicit rate; result is rounded to the target currency's minor units. */
export function convert(
  money: Money,
  rate: ExchangeRate,
  mode: RoundingMode = RoundingMode.HALF_UP,
): Money {
  assertValidExchangeRate(rate);
  if (money.currency !== rate.from) {
    throw new Error(`Rate converts ${rate.from}→${rate.to} but amount is in ${money.currency}`);
  }
  return Money.of(money.multiply(rate.rate).toDecimalString(), rate.to).round(mode);
}
