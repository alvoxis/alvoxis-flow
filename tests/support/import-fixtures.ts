import { type LayoutPage } from "@/modules/documents/import";

/**
 * SYNTHETIC layouts that imitate the *structure* of real-world invoices (two-column party blocks,
 * currency symbols in separate cells, labels on their own lines). All names, numbers, IBANs and
 * amounts are invented; the IBAN is the public ISO 13616 example.
 */
export const twoColumnInvoice: LayoutPage[] = [
  {
    lines: [
      "Date: 05.02.2026",
      "INVOICE Nr. 07/2026",
      "TO BE PAID BEFORE:",
      "15.02.2026",
      'SIA "Example Textiles"   CUSTOMER',
      "Address: Example iela 1, Rīga, LV-1000   Name: MV EXAMPLE STAR",
      "Riga, Latvia   Sample Agency Inc",
      "Reg.Nr.: LV40000000000   Address: 1 Sample Road, Sample City",
      "Bank: Example Bank AS   Phone:   10000000000",
      "SWIFT: EXAMLV2X",
      "IBAN: LV80BANK0000435195001   E-mail: agency@example.test",
      "QTY   DESCRIPTION   UNIT PRICE   TOTAL",
      "10   Rain jacket   €   55,00 €   550,00",
      "4   Work gloves   €   12,50 €   50,00",
      "2   Helmet   €   1 200,00 €   2 400,00",
      "SUB TOTAL: €   3 000,00",
      "SHIPPING: €   -",
      "0%   TAX RATE(S): €   -",
      "GRAND TOTAL: €   3 000,00",
      "NOTES: REF-SAMPLE-1",
      "This invoice is prepared electronically and is valid without signature.",
    ],
  },
];

export const proformaWithStatement: LayoutPage[] = [
  {
    lines: [
      "Proforma invoice No. 3/2026",
      'From:   SIA "Example Textiles"',
      "Reģ. Nr. LV40000000000",
      "LV80BANK0000435195001",
      'To:   Master of M/V "EXAMPLE"',
      "C/O Sample Agency",
      "Date:   12.03.2026",
      "Weight   Price   Price",
      "Description   Pcs   Kg   EUR   EUR",
      "Overalls   20   15.00   300.00",
      "Total   300.00",
      "P.O Number: PO-SAMPLE-9",
      "SHIP'S STORES IN TRANSIT",
    ],
  },
];

export const unlabelledIdentifierInvoice: LayoutPage[] = [
  {
    lines: [
      'SIA "Example Fashion"',
      "1 Example street, Riga, Latvia, LV-1000   Inv. 012-1/2026",
      "LV40000000001",
      "Bank: Example Bank AS. SWIFT : EXAMLV2X IBAN: LV80BANK0000435195001",
      "CUSTOMER",
      "Name:   Sample Studio Ltd   Date:   02.04.2026",
      "Reg. Number:   VAT Number: GB 123456789",
      "Qty   Description   Unit Price   TOTAL",
      "3   SHIRT   €   4.10 €   12.30",
      "5   TROUSERS   €   3.00 €   15.00",
      "SubTotal €   27.30",
      "Tax Rate(s)   0%",
      "Comments:   TOTAL €   27.30",
      "Payment terms:   PREPAYMENT",
      "TO BE PAID BEFORE: 06.04.2026",
    ],
  },
];
