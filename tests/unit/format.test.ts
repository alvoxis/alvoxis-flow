import { describe, expect, it } from "vitest";
import { formatDate, formatMoney } from "@/lib/format";

describe("formatMoney", () => {
  it("formats with the currency of the document, per locale", () => {
    expect(formatMoney("1234.5", "EUR", "en")).toBe("€1,234.50");
    // Non-breaking spaces vary by locale; normalise them for the assertion.
    // Latvian CLDR data does not group 4-digit numbers, so use 5 digits.
    expect(formatMoney("12345.5", "PLN", "lv").replace(/\s/g, " ")).toBe("12 345,50 PLN");
  });

  it("does not lose precision on large amounts", () => {
    expect(formatMoney("9007199254740993.01", "EUR", "en")).toBe("€9,007,199,254,740,993.01");
  });
});

describe("formatDate", () => {
  it("formats ISO dates independent of server time zone", () => {
    expect(formatDate("2026-10-01", "en")).toBe("1 Oct 2026");
  });
});
