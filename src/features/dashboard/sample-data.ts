import { type DocumentSummary } from "./types";

/**
 * SAMPLE DATA for the UI preview only. It is rendered with a visible "sample data" label
 * and is replaced by real tenant-scoped queries once the documents module exists.
 * Company names are well-known fictitious sample names.
 */
export const SAMPLE_MONTH = "2026-10";

export const SAMPLE_DOCUMENTS: readonly DocumentSummary[] = [
  {
    id: "s1",
    number: "INV-2026-0047",
    type: "invoice",
    customer: "Northwind Traders",
    issueDate: "2026-10-14",
    status: "sent",
    total: "4820.00",
    currency: "EUR",
  },
  {
    id: "s2",
    number: "DN-2026-0019",
    type: "deliveryNote",
    customer: "Northwind Traders",
    issueDate: "2026-10-14",
    status: "delivered",
    total: null,
    currency: "EUR",
  },
  {
    id: "s3",
    number: "INV-2026-0046",
    type: "invoice",
    customer: "Fabrikam Sp. z o.o.",
    issueDate: "2026-10-12",
    status: "approved",
    total: "12450.50",
    currency: "PLN",
  },
  {
    id: "s4",
    number: "CN-2026-0004",
    type: "creditNote",
    customer: "Contoso Retail",
    issueDate: "2026-10-10",
    status: "approved",
    total: "-310.00",
    currency: "EUR",
    creditsDocumentNumber: "INV-2026-0038",
  },
  {
    id: "s5",
    number: "PRO-2026-0012",
    type: "proforma",
    customer: "Tailspin Toys",
    issueDate: "2026-10-09",
    status: "sent",
    total: "1999.99",
    currency: "EUR",
  },
  {
    id: "s6",
    number: "INV-2026-0045",
    type: "invoice",
    customer: "Contoso Retail",
    issueDate: "2026-10-06",
    status: "paid",
    total: "2760.40",
    currency: "EUR",
  },
  {
    id: "s7",
    number: "INV-2026-0044",
    type: "invoice",
    customer: "Wide World Importers",
    issueDate: "2026-10-02",
    status: "overdue",
    total: "980.00",
    currency: "EUR",
  },
  {
    id: "s8",
    number: "INV-2026-0043",
    type: "invoice",
    customer: "Fabrikam Sp. z o.o.",
    issueDate: "2026-10-01",
    status: "draft",
    total: "3300.00",
    currency: "PLN",
  },
];
