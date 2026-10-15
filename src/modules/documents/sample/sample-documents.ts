import { type AppLocale } from "@/i18n/config";
import { calculateTotals } from "../domain/calculate";
import { buildCreditNote, buildDeliveryNoteFromInvoice } from "../domain/derive";
import { type DocumentDraft, type IssuedDocument, type TaxCategorySnapshot } from "../domain/types";
import { type DocumentPdfModel } from "../pdf/document-pdf";

/**
 * FICTITIOUS sample documents for previews and visual checks. Company names are invented, the IBAN
 * is the public ISO 13616 example, and the tax categories/rates are placeholders that do NOT
 * represent any country's actual rates or rules.
 */
const SAMPLE_TAX: Record<"standard" | "exempt", TaxCategorySnapshot> = {
  standard: { code: "S", kind: "standard", ratePercent: "20", label: "Sample rate" },
  exempt: {
    code: "E",
    kind: "exempt",
    ratePercent: "0",
    label: "Sample exemption",
    note: "Explanatory note entered by the user (sample).",
  },
};

export function sampleInvoice(language: AppLocale = "en"): IssuedDocument {
  const draft: DocumentDraft = {
    type: "invoice",
    language,
    currency: "EUR",
    issueDate: "2026-03-02",
    dueDate: "2026-03-16",
    seller: {
      name: "Example Workwear SIA",
      registrationNumber: "40000000000",
      vatNumber: "LV40000000000",
      address: {
        lines: ["Parauga iela 1"],
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
    buyerReference: "PO-SAMPLE-001",
    paymentTerms: "14 days",
    footer: "Sample footer text configured by the company.",
    lines: [
      {
        id: "a",
        kind: "item",
        description: "Winter jacket, size L",
        quantity: "10",
        unit: "pcs",
        unitPrice: "65.00",
        taxCategory: SAMPLE_TAX.standard,
        weightKg: "12.5",
      },
      {
        id: "b",
        kind: "item",
        description: "Safety boots",
        quantity: "10",
        unit: "pairs",
        unitPrice: "45.00",
        discountPercent: "5",
        taxCategory: SAMPLE_TAX.standard,
        weightKg: "15",
      },
      {
        id: "c",
        kind: "item",
        description: "Training session (sample exempt line)",
        quantity: "2.5",
        unit: "h",
        unitPrice: "40.00",
        taxCategory: SAMPLE_TAX.exempt,
      },
      {
        id: "d",
        kind: "charge",
        description: "Shipping",
        quantity: "1",
        unitPrice: "25.00",
        taxCategory: SAMPLE_TAX.standard,
      },
    ],
  };
  return {
    ...draft,
    id: "sample-invoice",
    number: "INV-2026-0001",
    status: "issued",
    issuedAt: "2026-03-02T09:00:00Z",
    totals: calculateTotals(draft),
    contentHash: "0".repeat(64),
  };
}

export function sampleModels(language: AppLocale = "en"): Record<string, DocumentPdfModel> {
  const inv = sampleInvoice(language);
  let n = 0;
  const newLineId = () => `x${++n}`;
  const credit = buildCreditNote(inv, [{ sourceLineId: "b", quantity: "2" }], [], {
    newLineId,
    issueDate: "2026-03-10",
  });
  const delivery = buildDeliveryNoteFromInvoice(inv, { newLineId, issueDate: "2026-03-03" });
  const proforma: DocumentDraft = {
    ...inv,
    type: "proforma",
    dueDate: undefined,
    validUntil: "2026-03-31",
    relation: undefined,
  };
  const pln: DocumentDraft = {
    ...inv,
    exchangeRate: {
      from: "EUR",
      to: "PLN",
      rate: "4.2500",
      rateDate: "2026-03-01",
      source: { kind: "manual", enteredByUserId: "sample" },
    },
  };
  return {
    invoice: {
      document: inv,
      status: "issued",
      number: inv.number,
      totals: inv.totals,
      contentHash: inv.contentHash,
    },
    "invoice-with-rate": {
      document: pln,
      status: "issued",
      number: "INV-2026-0002",
      totals: calculateTotals(pln),
      contentHash: inv.contentHash,
    },
    proforma: {
      document: proforma,
      status: "issued",
      number: "PF-2026-0001",
      totals: calculateTotals(proforma),
    },
    "credit-note": {
      document: credit,
      status: "issued",
      number: "CN-2026-0001",
      totals: calculateTotals(credit),
    },
    "delivery-note": { document: delivery, status: "issued", number: "DN-2026-0001", totals: null },
    "invoice-draft": { document: inv, status: "draft", number: null, totals: inv.totals },
  };
}
