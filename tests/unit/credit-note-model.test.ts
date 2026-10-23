import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREDIT_QUANTITY_DECIMALS,
  type CreditNoteForm,
  creditFormErrors,
  defaultCreditDate,
  normalizeQuantity,
  toCreditNoteBody,
} from "@/features/documents/credit-note-model";
import { LOCALES } from "@/i18n/config";
import { LIMITS } from "@/modules/documents/domain/validation";

const invoice = {
  issueDate: "2026-03-02",
  lines: [
    { id: "l1", description: "Winter jacket", quantity: "10", unit: "pcs" },
    { id: "l2", description: "Safety boots", quantity: "2.5", unit: "kg" },
  ],
};

function form(patch: Partial<CreditNoteForm> = {}): CreditNoteForm {
  return { mode: "full", issueDate: "2026-03-10", language: "en", quantities: {}, ...patch };
}

describe("credit note request body", () => {
  it('full mode sends "full" with the chosen date and language', () => {
    expect(toCreditNoteBody(form({ language: "lv" }), invoice.lines)).toEqual({
      issueDate: "2026-03-10",
      language: "lv",
      lines: "full",
    });
  });

  it("partial mode sends only the filled-in lines, with a decimal point", () => {
    const body = toCreditNoteBody(
      form({ mode: "partial", quantities: { l1: "", l2: " 1,25 " } }),
      invoice.lines,
    );
    expect(body.lines).toEqual([{ sourceLineId: "l2", quantity: "1.25" }]);
  });

  it("normalizes a decimal comma and spaces", () => {
    expect(normalizeQuantity(" 3,5 ")).toBe("3.5");
    expect(normalizeQuantity("4")).toBe("4");
  });
});

describe("credit note form checks (convenience only; the server decides)", () => {
  it("accepts a complete full or partial form", () => {
    expect(creditFormErrors(form(), invoice)).toEqual([]);
    expect(creditFormErrors(form({ issueDate: "2026-03-02" }), invoice)).toEqual([]);
    expect(
      creditFormErrors(form({ mode: "partial", quantities: { l1: "10", l2: "2,5" } }), invoice),
    ).toEqual([]);
  });

  it("requires a date that is not before the invoice", () => {
    expect(creditFormErrors(form({ issueDate: "" }), invoice)).toEqual([{ code: "dateRequired" }]);
    expect(creditFormErrors(form({ issueDate: "10.03.2026" }), invoice)).toEqual([
      { code: "dateRequired" },
    ]);
    expect(creditFormErrors(form({ issueDate: "2026-03-01" }), invoice)).toEqual([
      { code: "dateBeforeInvoice" },
    ]);
  });

  it("partial mode needs at least one line", () => {
    expect(creditFormErrors(form({ mode: "partial" }), invoice)).toEqual([{ code: "noLines" }]);
    expect(creditFormErrors(form({ mode: "partial", quantities: { l1: "  " } }), invoice)).toEqual([
      { code: "noLines" },
    ]);
  });

  it.each(["0", "0.0000", "-1", "abc", "1.23456", "1e3", "1.2.3"])(
    "refuses the quantity %s",
    (quantity) => {
      expect(
        creditFormErrors(form({ mode: "partial", quantities: { l1: quantity } }), invoice),
      ).toEqual([{ code: "quantityInvalid", lineId: "l1" }]);
    },
  );

  it("refuses more than the invoiced quantity, compared exactly as decimals", () => {
    const check = (l2: string) =>
      creditFormErrors(form({ mode: "partial", quantities: { l2 } }), invoice);
    expect(check("2.5")).toEqual([]);
    expect(check("2.4999")).toEqual([]);
    expect(check("2.5001")).toEqual([{ code: "quantityTooHigh", lineId: "l2" }]);
    expect(check("11")).toEqual([{ code: "quantityTooHigh", lineId: "l2" }]);
  });

  it("reports date and line mistakes together", () => {
    expect(
      creditFormErrors(
        form({ mode: "partial", issueDate: "2026-01-01", quantities: { l1: "0", l2: "3" } }),
        invoice,
      ),
    ).toEqual([
      { code: "dateBeforeInvoice" },
      { code: "quantityInvalid", lineId: "l1" },
      { code: "quantityTooHigh", lineId: "l2" },
    ]);
  });

  it("uses the same quantity precision as the document rules", () => {
    expect(CREDIT_QUANTITY_DECIMALS).toBe(LIMITS.quantityDecimals);
  });

  it("defaults the date to today, but never before the invoice", () => {
    expect(defaultCreditDate("2026-03-10", "2026-03-02")).toBe("2026-03-10");
    expect(defaultCreditDate("2026-02-01", "2026-03-02")).toBe("2026-03-02");
  });
});

describe("credit note texts", () => {
  /** Every creditNote.* code the API can answer for a request the dialog sends. */
  const RULE_CODES = [
    "creditNote.quantity.exceedsRemaining",
    "creditNote.amount.exceedsRemaining",
    "creditNote.nothingRemaining",
    "creditNote.quantity.invalid",
    "creditNote.sourceLine.unknown",
    "creditNote.dateBeforeOriginal",
  ];
  const FORM_CODES = [
    "dateRequired",
    "dateBeforeInvoice",
    "noLines",
    "quantityInvalid",
    "quantityTooHigh",
  ];

  const get = (tree: unknown, key: string) =>
    key.split(".").reduce<unknown>((node, k) => (node as Record<string, unknown>)?.[k], tree);

  it.each(LOCALES)("%s translates every rule code and form error", (locale) => {
    const messages = JSON.parse(
      readFileSync(path.resolve("messages", `${locale}.json`), "utf8"),
    ) as unknown;
    for (const code of RULE_CODES)
      expect(typeof get(messages, `documents.issues.${code}`), code).toBe("string");
    for (const code of FORM_CODES)
      expect(typeof get(messages, `documents.creditNote.errors.${code}`), code).toBe("string");
  });
});
