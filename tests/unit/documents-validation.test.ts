import { describe, expect, it } from "vitest";
import {
  hasBlockingIssues,
  validateDocument,
  type ValidationIssue,
} from "@/modules/documents/domain";
import { FIXTURE_TAX, invoiceDraft, line } from "../support/document-fixtures";

const codes = (issues: ValidationIssue[]) => issues.map((i) => i.code);

describe("validateDocument", () => {
  it("accepts a complete invoice", () => {
    const issues = validateDocument(invoiceDraft());
    expect(issues).toEqual([]);
    expect(hasBlockingIssues(issues)).toBe(false);
  });

  it("requires lines, seller, buyer and valid dates", () => {
    const issues = validateDocument(
      invoiceDraft({
        lines: [],
        seller: { name: " " },
        buyer: { name: "" },
        issueDate: "2026-02-30",
      }),
    );
    expect(codes(issues)).toEqual(
      expect.arrayContaining([
        "lines.required",
        "seller.name.required",
        "seller.address.required",
        "buyer.name.required",
        "date.invalid",
      ]),
    );
    expect(codes(issues)).toContain("seller.identifier.missing");
  });

  it("rejects a due date before the issue date", () => {
    expect(codes(validateDocument(invoiceDraft({ dueDate: "2026-03-01" })))).toContain(
      "dueDate.beforeIssueDate",
    );
  });

  it("rejects invalid quantities, prices and discounts", () => {
    const issues = validateDocument(
      invoiceDraft({
        lines: [
          line({ id: "a", quantity: "0" }),
          line({ id: "b", quantity: "1.23456" }),
          line({ id: "c", unitPrice: "1e2" }),
          line({ id: "d", unitPrice: null }),
          line({ id: "e", discountPercent: "101" }),
          line({ id: "e", description: "" }),
        ],
      }),
    );
    expect(codes(issues)).toEqual(
      expect.arrayContaining([
        "line.quantity.zero",
        "line.quantity.invalid",
        "line.unitPrice.invalid",
        "line.unitPrice.required",
        "line.discount.invalid",
        "line.id.duplicate",
        "line.description.required",
      ]),
    );
  });

  it("refuses an unexplained 0% 'standard' rate and asks for an explicit treatment", () => {
    const issues = validateDocument(
      invoiceDraft({
        lines: [
          line({
            id: "a",
            taxCategory: { code: "0", kind: "standard", ratePercent: "0", label: "0%" },
          }),
        ],
      }),
    );
    expect(codes(issues)).toContain("tax.rate.zeroRequiresTreatment");
  });

  it("requires zero rate for non-standard treatments and recommends an explanatory note", () => {
    const issues = validateDocument(
      invoiceDraft({
        lines: [
          line({ id: "a", taxCategory: { ...FIXTURE_TAX.exempt, ratePercent: "5" } }),
          line({ id: "b", taxCategory: { ...FIXTURE_TAX.reverse, note: undefined } }),
        ],
      }),
    );
    expect(issues).toContainEqual({
      code: "tax.rate.mustBeZeroForTreatment",
      severity: "error",
      path: "lines[0].taxCategory.ratePercent",
    });
    expect(issues).toContainEqual({
      code: "tax.note.recommended",
      severity: "warning",
      path: "lines[1].taxCategory.note",
    });
  });

  it("validates IBAN checksums and warns when an invoice has no bank account", () => {
    expect(
      codes(validateDocument(invoiceDraft({ bankAccounts: [{ iban: "LV80BANK0000435195002" }] }))),
    ).toContain("bankAccount.iban.invalid");
    expect(validateDocument(invoiceDraft({ bankAccounts: [] }))).toContainEqual({
      code: "bankAccount.missing",
      severity: "warning",
      path: "bankAccounts",
    });
  });

  it("requires invoices to have a positive total", () => {
    expect(
      codes(validateDocument(invoiceDraft({ lines: [line({ id: "a", quantity: "-1" })] }))),
    ).toContain("total.mustBePositive");
  });

  it("requires credit notes to reference the original invoice and to be negative", () => {
    const issues = validateDocument(
      invoiceDraft({ type: "credit_note", lines: [line({ id: "a", quantity: "1" })] }),
    );
    expect(codes(issues)).toEqual(
      expect.arrayContaining([
        "creditNote.originalInvoice.required",
        "creditNote.line.source.required",
        "creditNote.line.quantity.mustBeNegative",
      ]),
    );
  });

  it("allows delivery notes without prices or tax", () => {
    const issues = validateDocument(
      invoiceDraft({
        type: "delivery_note",
        bankAccounts: [],
        lines: [line({ id: "a", unitPrice: null, taxCategory: null, weightKg: "12.5" })],
      }),
    );
    expect(issues).toEqual([]);
  });

  it("rejects an exchange rate that does not start from the document currency", () => {
    const issues = validateDocument(
      invoiceDraft({
        currency: "PLN",
        exchangeRate: {
          from: "EUR",
          to: "PLN",
          rate: "4.25",
          rateDate: "2026-03-01",
          source: { kind: "manual", enteredByUserId: "u" },
        },
      }),
    );
    expect(codes(issues)).toContain("exchangeRate.currencyMismatch");
  });
});
