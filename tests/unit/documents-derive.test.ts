import { describe, expect, it } from "vitest";
import {
  buildCreditNote,
  buildDeliveryNoteFromInvoice,
  buildFullCreditNote,
  calculateTotals,
  canonicalJson,
  convertProformaToInvoice,
  DocumentRuleError,
  validateDocument,
} from "@/modules/documents/domain";
import { idGenerator, invoiceDraft, issued } from "../support/document-fixtures";

const rate = {
  from: "EUR" as const,
  to: "PLN" as const,
  rate: "4.2500",
  rateDate: "2026-03-01",
  source: { kind: "manual" as const, enteredByUserId: "u" },
};
const invoice = issued(invoiceDraft({ exchangeRate: rate }));

describe("buildCreditNote", () => {
  it("credits part of a line, links the invoice and keeps currency, tax and rate snapshot", () => {
    const cn = buildCreditNote(invoice, [{ sourceLineId: "l2", quantity: "2" }], [], {
      newLineId: idGenerator(),
      issueDate: "2026-03-10",
    });
    expect(cn.type).toBe("credit_note");
    expect(cn.relation).toEqual({
      kind: "credits",
      documentId: "doc-1",
      documentNumber: "INV-2026-0001",
      issueDate: "2026-03-02",
    });
    expect(cn.currency).toBe("EUR");
    expect(cn.exchangeRate).toEqual(rate);
    expect(cn.lines[0]).toMatchObject({
      quantity: "-2",
      unitPrice: "45.00",
      sourceLineId: "l2",
      taxCategory: invoice.lines[1]!.taxCategory,
    });
    expect(validateDocument(cn)).toEqual([]);
    const t = calculateTotals(cn);
    expect([t.netTotal, t.taxTotal, t.grossTotal]).toEqual(["-90.00", "-18.00", "-108.00"]);
  });

  it("supports price corrections with a lower unit price", () => {
    const cn = buildCreditNote(
      invoice,
      [{ sourceLineId: "l1", quantity: "10", unitPrice: "5.00", description: "Price correction" }],
      [],
      {
        newLineId: idGenerator(),
        issueDate: "2026-03-10",
      },
    );
    expect(calculateTotals(cn).netTotal).toBe("-50.00");
  });

  it("refuses to credit more than remains, considering earlier credit notes", () => {
    const params = { newLineId: idGenerator(), issueDate: "2026-03-10" };
    const first = buildCreditNote(invoice, [{ sourceLineId: "l2", quantity: "8" }], [], params);
    expect(() =>
      buildCreditNote(invoice, [{ sourceLineId: "l2", quantity: "3" }], first.lines, params),
    ).toThrow(DocumentRuleError);
    expect(() =>
      buildCreditNote(invoice, [{ sourceLineId: "l2", quantity: "2" }], first.lines, params),
    ).not.toThrow();
    // Two requests for the same line in one credit note are summed.
    expect(() =>
      buildCreditNote(
        invoice,
        [
          { sourceLineId: "l1", quantity: "6" },
          { sourceLineId: "l1", quantity: "5" },
        ],
        [],
        params,
      ),
    ).toThrow(/remaining quantity/);
    // Amount limit: a price correction after a full quantity credit is not possible.
    const fullL1 = buildCreditNote(invoice, [{ sourceLineId: "l1", quantity: "10" }], [], params);
    expect(() =>
      buildCreditNote(
        invoice,
        [{ sourceLineId: "l1", quantity: "0.0001", unitPrice: "1" }],
        fullL1.lines,
        params,
      ),
    ).toThrow();
  });

  it("rejects unknown lines, higher prices, early dates and non-invoices", () => {
    const params = { newLineId: idGenerator(), issueDate: "2026-03-10" };
    expect(() =>
      buildCreditNote(invoice, [{ sourceLineId: "nope", quantity: "1" }], [], params),
    ).toThrow(/not on the invoice/);
    expect(() =>
      buildCreditNote(
        invoice,
        [{ sourceLineId: "l1", quantity: "1", unitPrice: "99" }],
        [],
        params,
      ),
    ).toThrow(/exceeds the original/);
    expect(() =>
      buildCreditNote(invoice, [{ sourceLineId: "l1", quantity: "1" }], [], {
        ...params,
        issueDate: "2026-03-01",
      }),
    ).toThrow(/predate/);
    expect(() =>
      buildCreditNote(invoice, [{ sourceLineId: "l1", quantity: "-1" }], [], params),
    ).toThrow(/positive/);
    const proforma = issued(invoiceDraft({ type: "proforma" }));
    expect(() =>
      buildCreditNote(proforma, [{ sourceLineId: "l1", quantity: "1" }], [], params),
    ).toThrow(/issued invoice/);
  });

  it("buildFullCreditNote credits everything that remains", () => {
    const params = { newLineId: idGenerator(), issueDate: "2026-03-10" };
    const partial = buildCreditNote(invoice, [{ sourceLineId: "l1", quantity: "4" }], [], params);
    const rest = buildFullCreditNote(invoice, partial.lines, params);
    expect(rest.lines.map((l) => [l.sourceLineId, l.quantity])).toEqual([
      ["l1", "-6"],
      ["l2", "-10"],
    ]);
    const total = calculateTotals(rest).grossTotal;
    // 1320.00 gross − 312.00 already credited (4 × 65.00 = 260.00 net + 52.00 tax)
    expect(total).toBe("-1008.00");
  });

  it("buildFullCreditNote fails when nothing remains", () => {
    const params = { newLineId: idGenerator(), issueDate: "2026-03-10" };
    const full = buildFullCreditNote(invoice, [], params);
    expect(() => buildFullCreditNote(invoice, full.lines, params)).toThrow(/fully credited/);
  });
});

describe("delivery notes and proformas", () => {
  it("derives a price-free delivery note from an invoice", () => {
    const dn = buildDeliveryNoteFromInvoice(invoice, {
      newLineId: idGenerator(),
      issueDate: "2026-03-03",
    });
    expect(dn.type).toBe("delivery_note");
    expect(dn.lines.every((l) => l.unitPrice === null && l.taxCategory === null)).toBe(true);
    expect(dn.relation?.kind).toBe("delivers");
    expect(validateDocument(dn)).toEqual([]);
  });

  it("converts a proforma into a new invoice draft without carrying the rate snapshot", () => {
    const proforma = issued(
      invoiceDraft({ type: "proforma", validUntil: "2026-03-31", exchangeRate: rate }),
      "pf-1",
      "PF-0001",
    );
    const inv = convertProformaToInvoice(proforma, {
      newLineId: idGenerator(),
      issueDate: "2026-03-05",
      dueDate: "2026-03-19",
    });
    expect(inv).toMatchObject({
      type: "invoice",
      dueDate: "2026-03-19",
      relation: { kind: "converted_from", documentId: "pf-1" },
    });
    expect(inv.exchangeRate).toBeUndefined();
    expect(inv.validUntil).toBeUndefined();
    expect(calculateTotals(inv).grossTotal).toBe(calculateTotals(proforma).grossTotal);
  });
});

describe("canonicalJson", () => {
  it("is independent of key order and drops undefined values", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [1, "x"] } })).toBe(
      canonicalJson({ a: { c: [1, "x"] }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
