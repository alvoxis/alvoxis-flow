import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { calculateCost, priceForMargin } from "@/modules/costing/domain/calculate";

/**
 * Cost calculation: line bases, duty as a user-entered percentage of the customs value, piecework,
 * unit cost, margin vs markup, target price, scenarios with fixed costs spread over other
 * quantities, and warnings for unverified rates. Rates below are arbitrary test values.
 */
const base = {
  currency: "EUR" as const,
  quantity: "100",
  lines: [
    { category: "purchase" as const, basis: "per_unit" as const, amount: "4.50" },
    { category: "delivery" as const, basis: "total" as const, amount: "120" },
    { category: "insurance" as const, basis: "total" as const, amount: "30" },
    { category: "customs_duty" as const, basis: "percent" as const, amount: "10" },
    { category: "packaging" as const, basis: "per_unit" as const, amount: "0.35" },
    { category: "piecework" as const, basis: "piecework" as const, amount: "0.20" },
  ],
};

describe("calculateCost", () => {
  it("adds up every basis and reports the breakdown", () => {
    const r = calculateCost({ ...base, salePrice: "12" });
    // purchase 450 + delivery 120 + insurance 30 = customs value 600; duty 10 % = 60;
    // packaging 35; piecework 100 × 0.20 = 20 → 715.
    expect(r.lines.map((l) => l.total)).toEqual([
      "450.00",
      "120.00",
      "30.00",
      "60.00",
      "35.00",
      "20.00",
    ]);
    expect(r.totalCost).toBe("715.00");
    expect(r.unitCost).toBe("7.1500");
    expect(r.byCategory.find((c) => c.category === "purchase")?.share).toBe("62.94");
    expect(r.pricing).toEqual({
      salePrice: "12.0000",
      profitPerUnit: "4.8500",
      expectedProfit: "485.00",
      marginPercent: "40.42",
      markupPercent: "67.83",
      revenue: "1200.00",
    });
    // Unverified duty rate → warning, never silently trusted.
    expect(r.warnings).toEqual([{ index: 3, code: "unverified_rate" }]);
    expect(r.lines[3]!.needsVerification).toBe(true);
  });

  it("distinguishes margin from markup and finds the price for a target margin", () => {
    const r = calculateCost({
      currency: "EUR",
      quantity: "1",
      lines: [{ category: "purchase", basis: "total", amount: "60" }],
      salePrice: "100",
      targetMarginPercent: "40",
    });
    expect(r.pricing?.marginPercent).toBe("40.00");
    expect(r.pricing?.markupPercent).toBe("66.67");
    expect(r.priceForTargetMargin).toBe("100.0000");
    expect(priceForMargin(new Decimal("7.15"), new Decimal("50")).toFixed(2)).toBe("14.30");
  });

  it("spreads batch costs over other quantities in scenarios", () => {
    const r = calculateCost({
      ...base,
      lines: base.lines.map((l) => (l.basis === "percent" ? { ...l, verified: true } : l)),
      scenarios: [{ label: "Bigger batch", quantity: "200", salePrice: "10" }],
    });
    expect(r.warnings).toEqual([]);
    // 200: purchase 900 + 120 + 30 = 1050, duty 105, packaging 70, piecework 40 → 1265.
    expect(r.scenarios[0]).toMatchObject({ totalCost: "1265.00", unitCost: "6.3250" });
    expect(r.scenarios[0]!.pricing?.expectedProfit).toBe("735.00");
  });

  it("refuses invalid input and flags a duty without a customs value", () => {
    expect(() => calculateCost({ ...base, quantity: "0" })).toThrow();
    expect(() => calculateCost({ ...base, quantity: "-1" })).toThrow();
    expect(() =>
      calculateCost({ ...base, lines: [{ category: "other", basis: "total", amount: "1e3" }] }),
    ).toThrow();
    const r = calculateCost({
      currency: "PLN",
      quantity: "5",
      lines: [{ category: "customs_duty", basis: "percent", amount: "5", verified: true }],
    });
    expect(r.totalCost).toBe("0.00");
    expect(r.warnings).toEqual([{ index: 0, code: "percent_without_customs_value" }]);
    expect(r.pricing).toBeNull();
    expect(calculateCost({ ...base, lines: [] }).unitCost).toBe("0.0000");
  });

  it("is exact with decimals (no binary floating point)", () => {
    const r = calculateCost({
      currency: "EUR",
      quantity: "3",
      lines: [
        { category: "other", basis: "total", amount: "0.10" },
        { category: "other", basis: "total", amount: "0.20" },
      ],
    });
    expect(r.totalCost).toBe("0.30");
    expect(r.unitCost).toBe("0.1000");
  });
});
