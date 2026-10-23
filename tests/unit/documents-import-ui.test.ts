import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findingsToCheck,
  importFormProblems,
  initialImportForm,
  interpretImportResponse,
  MAX_UPLOAD_BYTES,
  needsDuplicateConfirmation,
  toImportDecisions,
} from "@/features/documents/import-model";
import { LOCALES } from "@/i18n/config";
import { importDecisionsSchema } from "@/modules/documents/import/decisions-schema";
import { type ImportReview } from "@/modules/documents/import/review";

/** A synthetic review as the parser returns it. */
function review(overrides: Partial<ImportReview> = {}): ImportReview {
  const field = <T>(value: T | null) => ({ value, confidence: "high" as const });
  return {
    status: "needs_review",
    fileSha256: "0".repeat(64),
    pageCount: 1,
    documentType: field("invoice"),
    number: field("INV-1"),
    issueDate: field("2026-03-02"),
    dueDate: field("2026-03-16"),
    currency: field("EUR"),
    seller: { name: field("Pārdevējs SIA"), lines: [] },
    buyer: { name: field("Pircējs SIA"), lines: [] },
    identifiers: [
      {
        label: "Reg. No.",
        value: "40000000001",
        kind: "registration",
        side: "buyer",
        evidence: "",
      },
      { label: "VAT No.", value: "LV40000000001", kind: "vat", side: "buyer", evidence: "" },
      {
        label: "Reg. No.",
        value: "40000000000",
        kind: "registration",
        side: "seller",
        evidence: "",
      },
    ],
    bankAccounts: [],
    buyerReference: field("PO-1"),
    paymentTerms: field(null),
    lines: [
      {
        description: "Winter jacket",
        quantity: "10",
        unit: "pcs",
        unitPrice: "65.00",
        total: "650.00",
        percentages: [],
        evidence: "",
        flags: [],
      },
      {
        description: "Boots",
        quantity: "2",
        unit: null,
        unitPrice: null,
        total: "90.00",
        percentages: [],
        evidence: "",
        flags: ["line.arithmeticMismatch"],
      },
    ],
    totals: {
      subtotal: field("740.00"),
      shipping: field(null),
      tax: field("155.40"),
      taxRateText: field("21%"),
      total: field("895.40"),
    },
    statements: [],
    flags: [
      { code: "date.formatAmbiguous", severity: "warning", field: "issueDate" },
      { code: "date.formatAmbiguous", severity: "warning", field: "dueDate" },
      { code: "bankAccount.ibanInvalid", severity: "error", field: "bankAccounts" },
      { code: "tax.treatmentRequiresConfirmation", severity: "info", field: "totals" },
    ],
    duplicates: [],
    ...overrides,
  };
}

const defaults = { language: "lv" as const, bankAccountId: "" };

describe("PDF import review form", () => {
  it("prefills only what was read from the file, never a tax category", () => {
    const form = initialImportForm(review(), defaults);
    expect(form).toMatchObject({
      type: "invoice",
      language: "lv",
      currency: "EUR",
      issueDate: "2026-03-02",
      dueDate: "2026-03-16",
      buyerName: "Pircējs SIA",
      buyerRegistrationNumber: "40000000001",
      buyerVatNumber: "LV40000000001",
      buyerReference: "PO-1",
      paymentTerms: "",
      defaultTaxCategoryId: "",
      acknowledged: [],
      acknowledgedDuplicates: false,
    });
    expect(form.lines[1]).toEqual({
      description: "Boots",
      quantity: "2",
      unit: "",
      unitPrice: "",
      total: "90.00",
      flags: ["line.arithmeticMismatch"],
    });
    // A credit note or an unknown type is never preselected; unsupported currencies neither.
    const other = review({
      documentType: { value: "credit_note", confidence: "low" },
      currency: { value: "USD" as "EUR", confidence: "low" },
    });
    expect(initialImportForm(other, defaults)).toMatchObject({ type: "invoice", currency: "" });
  });

  it("lists each warning/error finding once; info findings need no check", () => {
    expect(findingsToCheck(review())).toEqual(["date.formatAmbiguous", "bankAccount.ibanInvalid"]);
  });

  it("reports every gap before anything is sent", () => {
    const r = review({
      duplicates: [
        { documentId: "d1", number: "INV-1", reasons: ["same_file"], strength: "certain" },
      ],
    });
    const form = { ...initialImportForm(r, defaults), currency: "" as const, buyerName: " " };
    expect(importFormProblems(form, r)).toEqual([
      "currency",
      "buyerName",
      "taxCategory",
      "lines",
      "findings",
      "duplicates",
    ]);
    const ready = {
      ...form,
      currency: "EUR" as const,
      buyerName: "Pircējs SIA",
      defaultTaxCategoryId: "00000000-0000-4000-8000-000000000001",
      lines: form.lines.map((l) => ({ ...l, unitPrice: l.unitPrice || "45,00" })),
      acknowledged: findingsToCheck(r),
      acknowledgedDuplicates: true,
    };
    expect(importFormProblems(ready, r)).toEqual([]);
    expect(importFormProblems({ ...ready, lines: [] }, r)).toEqual(["lines"]);
    expect(
      importFormProblems({ ...ready, lines: [{ ...ready.lines[0]!, quantity: "0" }] }, r),
    ).toEqual(["lines"]);
    // "possible" duplicates are only shown, not a blocker.
    const possible = review({
      duplicates: [
        { documentId: "d1", number: null, reasons: ["same_date_total"], strength: "possible" },
      ],
    });
    expect(needsDuplicateConfirmation(possible)).toBe(false);
  });

  it("builds decisions the server accepts: seller name only, normalised lines, all checks", () => {
    const r = review();
    const form = {
      ...initialImportForm(r, defaults),
      defaultTaxCategoryId: "00000000-0000-4000-8000-000000000001",
      lines: initialImportForm(r, defaults).lines.map((l, i) =>
        i === 1 ? { ...l, unitPrice: " 45,00 ", unit: "pairs" } : l,
      ),
      acknowledged: findingsToCheck(r),
      paymentTerms: "   ",
    };
    const decisions = toImportDecisions(form, "SIA Mūsu Uzņēmums");
    expect(decisions).toEqual({
      type: "invoice",
      language: "lv",
      currency: "EUR",
      issueDate: "2026-03-02",
      dueDate: "2026-03-16",
      seller: { name: "SIA Mūsu Uzņēmums" },
      buyer: { name: "Pircējs SIA", registrationNumber: "40000000001", vatNumber: "LV40000000001" },
      buyerReference: "PO-1",
      defaultTaxCategoryId: "00000000-0000-4000-8000-000000000001",
      lines: [
        { description: "Winter jacket", quantity: "10", unit: "pcs", unitPrice: "65.00" },
        { description: "Boots", quantity: "2", unit: "pairs", unitPrice: "45.00" },
      ],
      acknowledgedFlags: [
        "date.formatAmbiguous",
        "bankAccount.ibanInvalid",
        "line.arithmeticMismatch",
      ],
    });
    expect(importDecisionsSchema.parse(decisions)).toEqual(decisions);
  });

  it("the decisions schema is strict and bounded", () => {
    const base = toImportDecisions(
      {
        ...initialImportForm(review(), defaults),
        defaultTaxCategoryId: "00000000-0000-4000-8000-000000000001",
        lines: [
          { description: "X", quantity: "1", unit: "", unitPrice: "1", total: null, flags: [] },
        ],
      },
      "Co",
    );
    for (const bad of [
      { ...base, extra: true },
      { ...base, type: "credit_note" },
      { ...base, defaultTaxCategoryId: "not-a-uuid" },
      { ...base, lines: [{ ...base.lines![0]!, unitPrice: "-1" }] },
      { ...base, lines: [{ ...base.lines![0]!, taxCategory: { code: "X" } }] },
      { ...base, lines: [] },
      { ...base, acknowledgedFlags: Array.from({ length: 101 }, () => "x") },
    ])
      expect(importDecisionsSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(
        false,
      );
  });

  it("classifies the answers of the import endpoints", () => {
    const r = review();
    expect(interpretImportResponse(200, { review: r })).toEqual({ kind: "review", review: r });
    expect(interpretImportResponse(201, { document: { id: "d1" } })).toEqual({
      kind: "created",
      documentId: "d1",
    });
    expect(interpretImportResponse(413, { error: "file_too_large" })).toEqual({ kind: "tooLarge" });
    expect(
      interpretImportResponse(409, { error: "invalid_state", code: "import.file.notPdf" }),
    ).toEqual({ kind: "file", code: "import.file.notPdf" });
    const issues = [{ code: "import.flags.unresolved", severity: "error", path: "" }];
    expect(interpretImportResponse(422, { error: "validation_failed", issues })).toEqual({
      kind: "invalid",
      issues,
    });
    expect(interpretImportResponse(403, { error: "two_factor_enrollment_required" }).kind).toBe(
      "twoFactor",
    );
    expect(interpretImportResponse(403, { error: "forbidden" }).kind).toBe("forbidden");
    expect(interpretImportResponse(401, {}).kind).toBe("signedOut");
    expect(interpretImportResponse(500, null).kind).toBe("error");
  });

  it("the upload limit stays below the 4.5 MB request limit of serverless hosting", () => {
    expect(MAX_UPLOAD_BYTES).toBeLessThan(4.5 * 1024 * 1024);
  });
});

describe("PDF import texts", () => {
  const source = readFileSync(
    path.resolve("src/modules/documents/import/parse-invoice.ts"),
    "utf8",
  );
  /** Every finding code the parser can produce, read from its source so new codes are caught. */
  const flagCodes = [
    ...new Set([
      ...[...source.matchAll(/code: "([a-zA-Z.]+)"/g)].map((m) => m[1]!),
      ...[...source.matchAll(/flags\.push\("([a-zA-Z.]+)"\)/g)].map((m) => m[1]!),
      "duplicate.possible",
    ]),
  ];
  const decisionCodes = [
    "import.flags.unresolved",
    "import.duplicates.unacknowledged",
    "import.line.incomplete",
    "import.line.flagsUnresolved",
  ];
  const get = (tree: unknown, key: string) =>
    key.split(".").reduce<unknown>((node, k) => (node as Record<string, unknown>)?.[k], tree);

  it("finds the parser's finding codes", () => {
    expect(flagCodes.length).toBeGreaterThan(20);
    expect(flagCodes).toContain("file.noTextLayer");
    expect(flagCodes).toContain("line.arithmeticMismatch");
  });

  it.each(LOCALES)("%s translates every finding and every refusal of a review", (locale) => {
    const messages = JSON.parse(readFileSync(path.resolve("messages", `${locale}.json`), "utf8"));
    for (const code of flagCodes)
      expect(typeof get(messages, `documents.import.flags.${code}`), code).toBe("string");
    for (const code of decisionCodes)
      expect(typeof get(messages, `documents.issues.${code}`), code).toBe("string");
  });
});
