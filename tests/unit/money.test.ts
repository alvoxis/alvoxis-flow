import { describe, expect, it } from "vitest";
import {
  convert,
  CurrencyMismatchError,
  InvalidAmountError,
  Money,
  RoundingMode,
  sum,
  type ExchangeRate,
} from "@/lib/money";

describe("Money", () => {
  it("adds decimal amounts without floating-point error", () => {
    const a = Money.of("0.1", "EUR");
    const b = Money.of("0.2", "EUR");
    expect(a.add(b).toDecimalString()).toBe("0.3");
  });

  it("rejects JavaScript numbers and malformed strings", () => {
    // @ts-expect-error — floats are not accepted on purpose
    expect(() => Money.of(0.1, "EUR")).toThrow(InvalidAmountError);
    expect(() => Money.of("1e3", "EUR")).toThrow(InvalidAmountError);
    expect(() => Money.of("12,50", "EUR")).toThrow(InvalidAmountError);
    expect(() => Money.of("", "EUR")).toThrow(InvalidAmountError);
  });

  it("accepts bigint amounts", () => {
    expect(Money.of(12n, "PLN").toFixed()).toBe("12.00");
  });

  it("refuses to combine different currencies", () => {
    expect(() => Money.of("1", "EUR").add(Money.of("1", "PLN"))).toThrow(CurrencyMismatchError);
    expect(() => Money.of("1", "EUR").compare(Money.of("1", "PLN"))).toThrow(CurrencyMismatchError);
  });

  it("keeps full precision until explicitly rounded", () => {
    const unit = Money.of("19.995", "EUR");
    expect(unit.multiply("3").toDecimalString()).toBe("59.985");
    expect(unit.multiply("3").round().toDecimalString()).toBe("59.99");
  });

  it("supports explicit rounding modes", () => {
    const m = Money.of("2.345", "EUR");
    expect(m.toFixed(RoundingMode.HALF_UP)).toBe("2.35");
    expect(m.toFixed(RoundingMode.HALF_EVEN)).toBe("2.34");
    expect(m.toFixed(RoundingMode.DOWN)).toBe("2.34");
    expect(Money.of("-2.345", "EUR").toFixed(RoundingMode.HALF_UP)).toBe("-2.35");
  });

  it("sums a list in a single currency", () => {
    const total = sum(
      [Money.of("10.10", "PLN"), Money.of("0.05", "PLN"), Money.of("-3", "PLN")],
      "PLN",
    );
    expect(total.toFixed()).toBe("7.15");
  });

  it("serialises to a decimal string, never a number", () => {
    expect(JSON.parse(JSON.stringify(Money.of("1234.50", "EUR")))).toEqual({
      amount: "1234.5",
      currency: "EUR",
    });
  });
});

describe("convert", () => {
  const rate: ExchangeRate = {
    from: "EUR",
    to: "PLN",
    rate: "4.2875", // test fixture value, not a real market rate
    rateDate: "2026-10-01",
    source: { kind: "manual", enteredByUserId: "test-user" },
  };

  it("converts with an explicit rate and rounds to target minor units", () => {
    expect(convert(Money.of("100.01", "EUR"), rate).toDecimalString()).toBe("428.79");
  });

  it("rejects a rate for the wrong source currency", () => {
    expect(() => convert(Money.of("1", "PLN"), rate)).toThrow(/converts EUR→PLN/);
  });

  it("rejects non-positive or malformed rates", () => {
    expect(() => convert(Money.of("1", "EUR"), { ...rate, rate: "0" })).toThrow();
    expect(() => convert(Money.of("1", "EUR"), { ...rate, rate: "-1" })).toThrow();
    expect(() => convert(Money.of("1", "EUR"), { ...rate, rateDate: "01.10.2026" })).toThrow();
    expect(() => convert(Money.of("1", "EUR"), { ...rate, to: "EUR" })).toThrow();
  });
});
