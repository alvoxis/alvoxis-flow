import { describe, expect, it } from "vitest";
import {
  calculatePayroll,
  DEFAULT_RATES,
  percentOf,
  sumAmounts,
  toCents,
} from "@/modules/payroll/domain/calculate";

/** Synthetic salaries; the rates are the editable starting values, not legal advice. */
describe("payroll calculation", () => {
  it("rounds percentages half up to cents with 3-decimal rates", () => {
    expect(percentOf(toCents("1000"), "10.5")).toBe(10500n);
    expect(percentOf(toCents("0.05"), "10")).toBe(1n); // 0.5 cent → 1
    expect(percentOf(toCents("0.04"), "10")).toBe(0n);
    expect(percentOf(toCents("1234.56"), "23.59")).toBe(29123n); // 291.2327 → 291.23
    expect(percentOf(toCents("1500"), "0.125")).toBe(188n); // 1.875 → 1.88
  });

  it("calculates a Latvian-style month with an allowance", () => {
    expect(
      calculatePayroll({ gross: "2000", allowance: "510", taxCredit: "0" }, DEFAULT_RATES.LV),
    ).toEqual({
      gross: "2000.00",
      employeeSocial: "210.00",
      health: "0.00",
      taxable: "1280.00",
      incomeTax: "326.40",
      net: "1463.60",
      employerSocial: "471.80",
      employerCost: "2471.80",
    });
  });

  it("applies health insurance and a tax credit (Polish-style settings)", () => {
    const r = calculatePayroll(
      { gross: "8000", allowance: "250", taxCredit: "300" },
      DEFAULT_RATES.PL,
    );
    // social 1096.80; health 9 % of 6903.20 = 621.29; taxable 6653.20; tax 798.38 − 300 = 498.38
    expect(r).toMatchObject({
      employeeSocial: "1096.80",
      health: "621.29",
      taxable: "6653.20",
      incomeTax: "498.38",
      net: "5783.53",
    });
  });

  it("never produces negative taxable income or tax", () => {
    const r = calculatePayroll(
      { gross: "300", allowance: "700", taxCredit: "50" },
      DEFAULT_RATES.EE,
    );
    expect(r).toMatchObject({ taxable: "0.00", incomeTax: "0.00", net: "289.20" });
  });

  it("sums amounts exactly", () => {
    expect(sumAmounts(["0.10", "0.20", "1463.60"])).toBe("1463.90");
    expect(sumAmounts([])).toBe("0.00");
  });
});

describe("run totals", () => {
  it("adds up per currency to the cent", async () => {
    const { runTotals } = await import("@/features/payroll/model");
    const line = (currency: "EUR" | "PLN", gross: string, net: string, employerCost: string) =>
      ({ currency, gross, net, employerCost }) as Parameters<typeof runTotals>[0][number];
    expect(
      runTotals([
        line("EUR", "2000.00", "1463.60", "2471.80"),
        line("EUR", "0.10", "0.10", "0.13"),
        line("PLN", "8000.00", "5783.53", "9638.40"),
      ]),
    ).toEqual([
      { currency: "EUR", gross: "2000.10", net: "1463.70", employerCost: "2471.93" },
      { currency: "PLN", gross: "8000.00", net: "5783.53", employerCost: "9638.40" },
    ]);
  });
});
