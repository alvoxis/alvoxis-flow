import { describe, expect, it } from "vitest";
import { isValidIban, maskIban } from "@/lib/iban";

describe("IBAN", () => {
  it("accepts documented example IBANs (with or without spaces)", () => {
    expect(isValidIban("LV80BANK0000435195001")).toBe(true);
    expect(isValidIban("LT12 1000 0111 0100 1000")).toBe(true);
    expect(isValidIban("EE38 2200 2210 2014 5685")).toBe(true);
    expect(isValidIban("PL61 1090 1014 0000 0712 1981 2874")).toBe(true);
  });

  it("rejects wrong checksums and malformed input", () => {
    expect(isValidIban("LV80BANK0000435195002")).toBe(false);
    expect(isValidIban("LV80")).toBe(false);
    expect(isValidIban("not an iban")).toBe(false);
  });

  it("masks all but the country code and last four characters", () => {
    expect(maskIban("LV80BANK0000435195001")).toBe("LV•• •••• 5001");
  });
});
