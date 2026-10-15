import { describe, expect, it } from "vitest";
import { type ExchangeRate } from "@/lib/money";
import { calculateTotals, lineNet } from "@/modules/documents/domain";
import { FIXTURE_TAX, invoiceDraft, line } from "../support/document-fixtures";

describe("lineNet", () => {
  it("multiplies quantity by unit price and rounds to minor units", () => {
    expect(
      lineNet(line({ id: "a", quantity: "3", unitPrice: "19.99", discountPercent: "15" }), {
        currency: "EUR",
      }).toFixed(),
    ).toBe(
      "50.97", // 59.97 × 0.85 = 50.9745
    );
    expect(
      lineNet(line({ id: "b", quantity: "2.5", unitPrice: "0.333" }), {
        currency: "PLN",
      }).toFixed(),
    ).toBe("0.83");
  });

  it("rounds negative (credit) lines symmetrically, half away from zero", () => {
    expect(
      lineNet(line({ id: "c", quantity: "-1", unitPrice: "2.345" }), { currency: "EUR" }).toFixed(),
    ).toBe("-2.35");
    expect(
      lineNet(line({ id: "d", quantity: "1", unitPrice: "2.345" }), { currency: "EUR" }).toFixed(),
    ).toBe("2.35");
  });

  it("refuses lines without a price", () => {
    expect(() => lineNet(line({ id: "e", unitPrice: null }), { currency: "EUR" })).toThrow(
      /no unit price/,
    );
  });
});

describe("calculateTotals", () => {
  it("sums lines and applies the line's tax category", () => {
    const t = calculateTotals(invoiceDraft());
    expect(t.lines).toEqual([
      { lineId: "l1", net: "650.00" },
      { lineId: "l2", net: "450.00" },
    ]);
    expect(t.taxSummary).toEqual([
      {
        code: "T20",
        kind: "standard",
        ratePercent: "20",
        label: "Fixture 20%",
        taxableAmount: "1100.00",
        taxAmount: "220.00",
      },
    ]);
    expect([t.netTotal, t.taxTotal, t.grossTotal]).toEqual(["1100.00", "220.00", "1320.00"]);
  });

  it("keeps separate summary rows per tax category, including zero-rated, exempt and reverse charge", () => {
    const t = calculateTotals(
      invoiceDraft({
        lines: [
          line({ id: "a", unitPrice: "100.00", taxCategory: FIXTURE_TAX.standard20 }),
          line({ id: "b", unitPrice: "40.00", taxCategory: FIXTURE_TAX.reduced75 }),
          line({ id: "c", unitPrice: "30.00", taxCategory: FIXTURE_TAX.zero }),
          line({ id: "d", unitPrice: "20.00", taxCategory: FIXTURE_TAX.exempt }),
          line({ id: "e", unitPrice: "10.00", taxCategory: FIXTURE_TAX.reverse }),
          line({
            id: "f",
            kind: "charge",
            description: "Shipping",
            unitPrice: "5.00",
            taxCategory: FIXTURE_TAX.standard20,
          }),
        ],
      }),
    );
    const byCode = Object.fromEntries(t.taxSummary.map((r) => [r.code, r]));
    expect(byCode.T20).toMatchObject({ taxableAmount: "105.00", taxAmount: "21.00" });
    expect(byCode["T7.5"]).toMatchObject({ taxableAmount: "40.00", taxAmount: "3.00" });
    expect(byCode.Z0).toMatchObject({
      taxableAmount: "30.00",
      taxAmount: "0.00",
      note: FIXTURE_TAX.zero.note,
    });
    expect(byCode.EX).toMatchObject({
      kind: "exempt",
      taxAmount: "0.00",
      note: FIXTURE_TAX.exempt.note,
    });
    expect(byCode.RC).toMatchObject({ kind: "reverse_charge", taxAmount: "0.00" });
    expect([t.netTotal, t.taxTotal, t.grossTotal]).toEqual(["205.00", "24.00", "229.00"]);
  });

  it("never charges tax for non-standard kinds even if a rate is present", () => {
    const t = calculateTotals(
      invoiceDraft({
        lines: [line({ id: "a", taxCategory: { ...FIXTURE_TAX.exempt, ratePercent: "20" } })],
      }),
    );
    expect(t.taxTotal).toBe("0.00");
  });

  it("supports per-group and per-line tax rounding, which can differ", () => {
    const lines = ["a", "b", "c"].map((id) =>
      line({ id, unitPrice: "0.05", taxCategory: FIXTURE_TAX.reduced75 }),
    );
    // Per line: 0.05 × 7.5% = 0.00375 → 0.00 each. Per group: 0.15 × 7.5% = 0.01125 → 0.01.
    expect(calculateTotals(invoiceDraft({ lines }), { taxRounding: "per_group" }).taxTotal).toBe(
      "0.01",
    );
    expect(calculateTotals(invoiceDraft({ lines }), { taxRounding: "per_line" }).taxTotal).toBe(
      "0.00",
    );
  });

  it("produces negative totals for credit-note lines", () => {
    const t = calculateTotals(
      invoiceDraft({
        type: "credit_note",
        lines: [line({ id: "a", quantity: "-2", unitPrice: "45.00" })],
      }),
    );
    expect([t.netTotal, t.taxTotal, t.grossTotal]).toEqual(["-90.00", "-18.00", "-108.00"]);
  });

  it("computes PLN documents in PLN", () => {
    const t = calculateTotals(
      invoiceDraft({
        currency: "PLN",
        lines: [line({ id: "a", quantity: "3", unitPrice: "33.33" })],
      }),
    );
    expect(t.currency).toBe("PLN");
    expect(t.grossTotal).toBe("119.99"); // 99.99 + 20.00 (19.998 → 20.00)
  });

  it("keeps precision for large documents", () => {
    const lines = Array.from({ length: 500 }, (_, i) =>
      line({ id: `l${i}`, quantity: "9999.9999", unitPrice: "9999.9999" }),
    );
    const t = calculateTotals(invoiceDraft({ lines }));
    // each line: 99999998.00000001 → 99999998.00
    expect(t.netTotal).toBe("49999999000.00");
  });

  describe("exchange-rate snapshot", () => {
    const rate: ExchangeRate = {
      from: "EUR",
      to: "PLN",
      rate: "4.2500", // fixture value
      rateDate: "2026-03-01",
      source: { kind: "manual", enteredByUserId: "fixture-user" },
    };

    it("adds converted totals without altering document-currency totals", () => {
      const t = calculateTotals(invoiceDraft({ exchangeRate: rate }));
      expect(t.currency).toBe("EUR");
      expect(t.grossTotal).toBe("1320.00");
      expect(t.converted).toMatchObject({
        currency: "PLN",
        netTotal: "4675.00",
        taxTotal: "935.00",
        grossTotal: "5610.00",
      });
      expect(t.converted?.rate).toEqual(rate);
    });

    it("keeps converted totals internally consistent (gross = net + tax)", () => {
      const t = calculateTotals(
        invoiceDraft({
          exchangeRate: rate,
          lines: [
            line({ id: "a", unitPrice: "1102.50" }),
            line({ id: "b", unitPrice: "100.00", taxCategory: FIXTURE_TAX.exempt }),
          ],
        }),
      );
      // 1202.50 × 4.25 = 5110.625 → 5110.63; 220.50 × 4.25 = 937.125 → 937.13; gross = their sum
      expect(t.converted).toMatchObject({
        netTotal: "5110.63",
        taxTotal: "937.13",
        grossTotal: "6047.76",
      });
    });

    it("rejects a rate that does not start from the document currency", () => {
      expect(() => calculateTotals(invoiceDraft({ currency: "PLN", exchangeRate: rate }))).toThrow(
        /converts from EUR/,
      );
    });
  });
});
