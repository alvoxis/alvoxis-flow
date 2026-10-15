import Decimal from "decimal.js";
import { CURRENCY_MINOR_UNITS, type CurrencyCode, isCurrencyCode } from "./currency";

/**
 * Isolated Decimal constructor so global configuration elsewhere cannot change our
 * precision or rounding. 40 significant digits is far beyond any business amount.
 */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/**
 * Explicit rounding modes. Which mode applies to which document/country is a business
 * rule that must be verified against official sources before use; nothing here asserts
 * legal compliance.
 */
export const RoundingMode = {
  HALF_UP: D.ROUND_HALF_UP,
  HALF_EVEN: D.ROUND_HALF_EVEN,
  DOWN: D.ROUND_DOWN,
  UP: D.ROUND_UP,
} as const;
export type RoundingMode = (typeof RoundingMode)[keyof typeof RoundingMode];

export class CurrencyMismatchError extends Error {
  constructor(a: CurrencyCode, b: CurrencyCode) {
    super(`Currency mismatch: ${a} vs ${b}. Convert explicitly with an exchange rate.`);
    this.name = "CurrencyMismatchError";
  }
}

export class InvalidAmountError extends Error {
  constructor(value: unknown) {
    super(`Invalid monetary amount: ${String(value)}`);
    this.name = "InvalidAmountError";
  }
}

/** Accept only decimal strings or bigint. Floats are rejected to avoid binary rounding. */
export type AmountInput = string | bigint;

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

function toDecimal(value: AmountInput): Decimal {
  if (typeof value === "bigint") return new D(value.toString());
  if (typeof value !== "string" || !DECIMAL_STRING.test(value.trim())) {
    throw new InvalidAmountError(value);
  }
  return new D(value.trim());
}

/**
 * Immutable monetary value. Amounts are kept at full precision internally; call
 * `round()` when a value must be fixed to the currency's minor units (e.g. a line total).
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: CurrencyCode,
  ) {}

  static of(amount: AmountInput, currency: CurrencyCode): Money {
    if (!isCurrencyCode(currency)) throw new Error(`Unsupported currency: ${String(currency)}`);
    return new Money(toDecimal(amount), currency);
  }

  static zero(currency: CurrencyCode): Money {
    return Money.of("0", currency);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency)
      throw new CurrencyMismatchError(this.currency, other.currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  /** Multiply by a dimensionless factor such as a quantity or percentage (as a decimal string). */
  multiply(factor: AmountInput): Money {
    return new Money(this.value.times(toDecimal(factor)), this.currency);
  }

  round(mode: RoundingMode = RoundingMode.HALF_UP): Money {
    return new Money(
      this.value.toDecimalPlaces(CURRENCY_MINOR_UNITS[this.currency], mode),
      this.currency,
    );
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }

  /** Full-precision decimal string, suitable for persistence in NUMERIC columns. */
  toDecimalString(): string {
    return this.value.toFixed();
  }

  /** Fixed to minor units, e.g. "12.30". Rounds with the given mode. */
  toFixed(mode: RoundingMode = RoundingMode.HALF_UP): string {
    return this.value.toFixed(CURRENCY_MINOR_UNITS[this.currency], mode);
  }

  toJSON(): { amount: string; currency: CurrencyCode } {
    return { amount: this.toDecimalString(), currency: this.currency };
  }
}

export function sum(items: readonly Money[], currency: CurrencyCode): Money {
  return items.reduce((acc, m) => acc.add(m), Money.zero(currency));
}
