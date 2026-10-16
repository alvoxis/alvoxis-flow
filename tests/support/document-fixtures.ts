import {
  type DocumentDraft,
  type DocumentLine,
  type IssuedDocument,
  type TaxCategorySnapshot,
} from "@/modules/documents/domain";

/**
 * FICTITIOUS test data only. Names are invented; the IBAN is the public ISO 13616 documentation
 * example for Latvia. Tax rates below are arbitrary fixture values, NOT real country rates.
 */
export const FIXTURE_TAX = {
  standard20: { code: "T20", kind: "standard", ratePercent: "20", label: "Fixture 20%" },
  reduced75: { code: "T7.5", kind: "standard", ratePercent: "7.5", label: "Fixture 7.5%" },
  zero: {
    code: "Z0",
    kind: "zero_rated",
    ratePercent: "0",
    label: "Fixture zero-rated",
    note: "Fixture note: zero-rated supply.",
  },
  exempt: {
    code: "EX",
    kind: "exempt",
    ratePercent: "0",
    label: "Fixture exempt",
    note: "Fixture note: exemption basis entered by user.",
  },
  reverse: {
    code: "RC",
    kind: "reverse_charge",
    ratePercent: "0",
    label: "Fixture reverse charge",
    note: "Fixture note: reverse charge.",
  },
} satisfies Record<string, TaxCategorySnapshot>;

export function line(overrides: Partial<DocumentLine> & Pick<DocumentLine, "id">): DocumentLine {
  return {
    kind: "item",
    description: `Fixture item ${overrides.id}`,
    quantity: "1",
    unit: "pcs",
    unitPrice: "10.00",
    taxCategory: FIXTURE_TAX.standard20,
    ...overrides,
  };
}

export function invoiceDraft(overrides: Partial<DocumentDraft> = {}): DocumentDraft {
  return {
    type: "invoice",
    language: "en",
    currency: "EUR",
    issueDate: "2026-03-02",
    dueDate: "2026-03-16",
    seller: {
      name: "Example Workwear SIA",
      registrationNumber: "40000000000",
      vatNumber: "LV40000000000",
      address: {
        lines: ["Example street 1"],
        postalCode: "LV-1000",
        city: "Rīga",
        countryCode: "LV",
      },
      email: "billing@example.test",
    },
    buyer: {
      name: "Sample Shipping Agency Ltd",
      address: { lines: ["1 Sample Avenue"], city: "Sample City", countryCode: "CA" },
      email: "agency@example.test",
    },
    bankAccounts: [{ bankName: "Example Bank AS", iban: "LV80BANK0000435195001", bic: "EXAMLV2X" }],
    buyerReference: "PO-TEST-001",
    paymentTerms: "Payment within 14 days",
    footer: "This document was prepared electronically.",
    lines: [
      line({ id: "l1", description: "Winter jacket", quantity: "10", unitPrice: "65.00" }),
      line({ id: "l2", description: "Safety boots", quantity: "10", unitPrice: "45.00" }),
    ],
    ...overrides,
  };
}

export function issued(
  draft: DocumentDraft,
  id = "doc-1",
  number = "INV-2026-0001",
): IssuedDocument {
  return {
    ...draft,
    id,
    number,
    status: "issued",
    issuedAt: `${draft.issueDate}T10:00:00Z`,
    totals: null,
    contentHash: "fixture",
  };
}

export function idGenerator(prefix = "n"): () => string {
  let i = 0;
  return () => `${prefix}${++i}`;
}

/**
 * Company-profile values that produce exactly the fixture seller above (synthetic data). The
 * seller on documents comes from the profile, so test companies get this profile.
 */
export const FIXTURE_SELLER_PROFILE = {
  legalName: "Example Workwear SIA",
  registrationNumber: "40000000000",
  vatNumber: "LV40000000000",
  addressLine1: "Example street 1",
  postalCode: "LV-1000",
  city: "Rīga",
} as const;
