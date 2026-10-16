import { describe, expect, it } from "vitest";
import {
  extractLayout,
  findDuplicates,
  type ImportDecisions,
  ImportDecisionError,
  type ImportReview,
  parseAmount,
  parseDate,
  parseInvoiceLayout,
  toDraftInput,
} from "@/modules/documents/import";
import { validateDocument, parseDraftInput } from "@/modules/documents/domain";
import { renderDocumentPdf } from "@/modules/documents/pdf/render";
import { sampleModels } from "@/modules/documents/sample/sample-documents";
import { FIXTURE_TAX } from "../support/document-fixtures";
import {
  proformaWithStatement,
  twoColumnInvoice,
  unlabelledIdentifierInvoice,
} from "../support/import-fixtures";

const codes = (r: ImportReview) => r.flags.map((f) => f.code);

describe("value parsers", () => {
  it.each([
    ["1 234,56", "1234.56"],
    ["1,234.56", "1234.56"],
    ["12.450,50", "12450.50"],
    ["€ 65,00", "65.00"],
    ["2 050,00€", "2050.00"],
    ["-310.00", "-310.00"],
    ["(42.10)", "-42.10"],
    ["1.234.567", "1234567"],
  ])("parseAmount(%s) = %s", (input, expected) => {
    expect(parseAmount(input)).toEqual({ value: expected, ambiguous: false });
  });

  it("marks a single separator followed by three digits as ambiguous", () => {
    expect(parseAmount("1,234")).toEqual({ value: "1234", ambiguous: true });
  });

  it("reads a dash as 'no amount' and rejects text", () => {
    expect(parseAmount("€ -").value).toBeNull();
    expect(parseAmount("abc").value).toBeNull();
  });

  it("parses dates and flags day/month ambiguity", () => {
    expect(parseDate("Date: 05.02.2026")).toMatchObject({ value: "2026-02-05", ambiguous: false });
    expect(parseDate("2026-02-05")).toMatchObject({ value: "2026-02-05", ambiguous: false });
    expect(parseDate("05/02/2026")).toMatchObject({ value: "2026-02-05", ambiguous: true });
    expect(parseDate("25/02/2026")).toMatchObject({ value: "2026-02-25", ambiguous: false });
    expect(parseDate("31.02.2026").value).toBeNull();
  });
});

describe("parseInvoiceLayout", () => {
  it("reads a two-column invoice and flags what cannot be decided automatically", () => {
    const r = parseInvoiceLayout(twoColumnInvoice, "sha");
    expect(r.status).toBe("needs_review");
    expect(r.documentType.value).toBe("invoice");
    expect(r.number.value).toBe("07/2026");
    expect(r.issueDate).toMatchObject({ value: "2026-02-05", confidence: "high" });
    expect(r.dueDate).toMatchObject({ value: "2026-02-15", confidence: "high" });
    expect(r.currency.value).toBe("EUR");
    expect(r.seller.name.value).toBe('SIA "Example Textiles"');
    expect(r.buyer.name.value).toBe("MV EXAMPLE STAR");
    expect(r.bankAccounts).toEqual([
      expect.objectContaining({
        iban: "LV80BANK0000435195001",
        checksumValid: true,
        bic: "EXAMLV2X",
      }),
    ]);
    expect(r.lines).toEqual([
      expect.objectContaining({
        description: "Rain jacket",
        quantity: "10",
        unitPrice: "55.00",
        total: "550.00",
        flags: [],
      }),
      expect.objectContaining({
        description: "Work gloves",
        quantity: "4",
        unitPrice: "12.50",
        total: "50.00",
      }),
      expect.objectContaining({
        description: "Helmet",
        quantity: "2",
        unitPrice: "1200.00",
        total: "2400.00",
      }),
    ]);
    expect(r.totals.subtotal.value).toBe("3000.00");
    expect(r.totals.total.value).toBe("3000.00");
    expect(r.totals.taxRateText.value).toBe("0%");
    expect(codes(r)).toEqual(
      expect.arrayContaining([
        "identifier.labelMismatch",
        "tax.zeroRateUnexplained",
        "tax.treatmentRequiresConfirmation",
      ]),
    );
    expect(codes(r)).not.toContain("totals.linesMismatch");
    expect(codes(r)).not.toContain("bankAccount.ibanInvalid");
  });

  it("reads a proforma without a tax line and surfaces, but does not interpret, statements", () => {
    const r = parseInvoiceLayout(proformaWithStatement, "sha");
    expect(r.documentType.value).toBe("proforma");
    expect(r.number.value).toBe("3/2026");
    expect(r.dueDate.value).toBeNull();
    expect(r.lines).toEqual([
      expect.objectContaining({
        description: "Overalls",
        quantity: "20",
        unitPrice: "15.00",
        total: "300.00",
      }),
    ]);
    expect(r.totals.total.value).toBe("300.00");
    expect(r.buyerReference.value).toBe("PO-SAMPLE-9");
    expect(r.statements).toEqual(["SHIP'S STORES IN TRANSIT"]);
    expect(codes(r)).toEqual(expect.arrayContaining(["tax.notShown", "statements.found"]));
    expect(codes(r)).not.toContain("tax.zeroRateUnexplained");
  });

  it("flags unlabelled identifiers and keeps the buyer's VAT number on the buyer side", () => {
    const r = parseInvoiceLayout(unlabelledIdentifierInvoice, "sha");
    expect(r.number.value).toBe("012-1/2026");
    expect(r.buyer.name.value).toBe("Sample Studio Ltd");
    expect(r.paymentTerms.value).toBe("PREPAYMENT");
    expect(r.dueDate.value).toBe("2026-04-06");
    expect(r.identifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "LV40000000001", kind: "unknown" }),
        expect.objectContaining({ value: "GB123456789", kind: "vat", side: "buyer" }),
      ]),
    );
    expect(r.totals.total.value).toBe("27.30");
    expect(codes(r)).toContain("identifier.unlabelled");
  });

  it("flags arithmetic mismatches instead of correcting them", () => {
    const pages = [
      { lines: twoColumnInvoice[0]!.lines.map((l) => l.replace("€   550,00", "€   560,00")) },
    ];
    const r = parseInvoiceLayout(pages, "sha");
    expect(r.lines[0]!.flags).toContain("line.arithmeticMismatch");
    expect(codes(r)).toEqual(
      expect.arrayContaining(["lines.arithmeticMismatch", "totals.linesMismatch"]),
    );
  });

  it("reports missing essentials as errors", () => {
    const r = parseInvoiceLayout([{ lines: ["Hello", "Nothing to see here"] }], "sha");
    expect(codes(r)).toEqual(
      expect.arrayContaining([
        "currency.notFound",
        "total.notFound",
        "lines.notFound",
        "number.notFound",
        "issueDate.notFound",
        "documentType.unknown",
      ]),
    );
    expect(parseInvoiceLayout([], "sha").flags.map((f) => f.code)).toContain("file.noTextLayer");
  });

  it("flags documents that mention two currencies", () => {
    const pages = [{ lines: [...twoColumnInvoice[0]!.lines, "Information: 12 750,00 PLN"] }];
    expect(codes(parseInvoiceLayout(pages, "sha"))).toContain("currency.multiple");
  });
});

describe("round trip through real PDF bytes", { timeout: 30_000 }, () => {
  it.each(["en", "lv", "et"] as const)(
    "re-reads an ALVOXIS Flow invoice rendered in %s",
    async (lang) => {
      const bytes = await renderDocumentPdf(sampleModels(lang).invoice!);
      const r = parseInvoiceLayout(await extractLayout(new Uint8Array(bytes)), "sha");
      expect(r.documentType.value).toBe("invoice");
      expect(r.number.value).toBe("INV-2026-0001");
      expect(r.issueDate.value).toBe("2026-03-02");
      expect(r.dueDate.value).toBe("2026-03-16");
      expect(r.currency.value).toBe("EUR");
      expect(r.totals.total.value).toBe("1423.00");
      expect(r.lines).toHaveLength(4);
      expect(r.lines[0]).toMatchObject({ quantity: "10", unitPrice: "65.00", total: "650.00" });
      expect(r.bankAccounts[0]).toMatchObject({
        iban: "LV80BANK0000435195001",
        checksumValid: true,
      });
      if (lang === "en")
        expect(codes(r)).toContain("date.formatAmbiguous"); // 02/03/2026
      else expect(codes(r)).not.toContain("date.formatAmbiguous"); // 02.03.2026
    },
  );
});

describe("findDuplicates", () => {
  const review = parseInvoiceLayout(twoColumnInvoice, "file-hash");
  const base = {
    type: "invoice" as const,
    currency: "EUR",
    sellerName: null,
    sourceFileSha256: null,
  };

  it("ranks identical files and same number + date as certain", () => {
    const d = findDuplicates(review, [
      {
        ...base,
        id: "a",
        number: "X",
        issueDate: "2020-01-01",
        grossTotal: "1",
        buyerName: null,
        sourceFileSha256: "file-hash",
      },
      {
        ...base,
        id: "b",
        number: "07/2026",
        issueDate: "2026-02-05",
        grossTotal: "3000.00",
        buyerName: "MV Example Star",
      },
    ]);
    expect(d.map((x) => [x.documentId, x.strength])).toEqual([
      ["a", "certain"],
      ["b", "certain"],
    ]);
    expect(d[1]!.reasons).toEqual(["same_number", "same_party_date_total"]);
  });

  it("reports weaker matches without blocking", () => {
    const d = findDuplicates(review, [
      {
        ...base,
        id: "c",
        number: "OTHER",
        issueDate: "2026-02-05",
        grossTotal: "3000.00",
        buyerName: "Unrelated",
      },
      {
        ...base,
        id: "d",
        number: "OTHER",
        issueDate: "2026-02-06",
        grossTotal: "3000.00",
        buyerName: "MV EXAMPLE STAR",
      },
    ]);
    expect(d).toEqual([
      expect.objectContaining({
        documentId: "c",
        strength: "possible",
        reasons: ["same_date_total"],
      }),
    ]);
  });
});

describe("toDraftInput", () => {
  const review = parseInvoiceLayout(twoColumnInvoice, "sha");
  const decisions: ImportDecisions = {
    type: "invoice",
    language: "en",
    currency: "EUR",
    issueDate: "2026-02-05",
    dueDate: "2026-02-15",
    seller: {
      name: "Example Textiles SIA",
      address: { lines: ["Example iela 1"], city: "Rīga", countryCode: "LV" },
    },
    buyer: { name: "MV EXAMPLE STAR" },
    bankAccounts: [{ iban: "LV80BANK0000435195001" }],
    defaultTaxCategoryId: "00000000-0000-4000-8000-000000000000",
    acknowledgedFlags: ["identifier.labelMismatch", "tax.zeroRateUnexplained"],
  };

  it("refuses while findings are unresolved", () => {
    expect(() => toDraftInput(review, { ...decisions, acknowledgedFlags: [] })).toThrow(
      ImportDecisionError,
    );
  });

  it("refuses unacknowledged likely duplicates", () => {
    const withDup: ImportReview = {
      ...review,
      duplicates: [
        { documentId: "x", number: "07/2026", reasons: ["same_number"], strength: "likely" },
      ],
    };
    expect(() => toDraftInput(withDup, decisions)).toThrow(/already exist/);
    expect(() =>
      toDraftInput(withDup, { ...decisions, acknowledgedDuplicates: true }),
    ).not.toThrow();
  });

  it("produces a valid draft with the tax treatment chosen by the user", () => {
    const input = toDraftInput(review, decisions);
    expect(input.lines).toHaveLength(3);
    // Lines reference the chosen company category; the server builds the snapshot from it.
    expect(input.lines.every((l) => l.taxCategoryId === decisions.defaultTaxCategoryId)).toBe(true);
    let n = 0;
    const draft = parseDraftInput(input, () => `l${++n}`);
    expect(draft.lines.every((l) => l.taxCategoryId === decisions.defaultTaxCategoryId)).toBe(true);
    const resolved = {
      ...draft,
      lines: draft.lines.map((l) => ({ ...l, taxCategory: FIXTURE_TAX.zero })),
    };
    expect(validateDocument(resolved).filter((i) => i.severity === "error")).toEqual([]);
  });
});
