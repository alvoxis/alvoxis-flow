import { extractText, getDocumentProxy, getMeta } from "unpdf";
import { describe, expect, it } from "vitest";
import { calculateTotals, type DocumentDraft } from "@/modules/documents/domain";
import { type DocumentPdfModel } from "@/modules/documents/pdf/document-pdf";
import { renderDocumentPdf } from "@/modules/documents/pdf/render";
import { sampleInvoice, sampleModels } from "@/modules/documents/sample/sample-documents";

async function pdfText(
  model: DocumentPdfModel,
): Promise<{ text: string; pages: number; bytes: Buffer }> {
  const bytes = await renderDocumentPdf(model);
  const { text, totalPages } = await extractText(new Uint8Array(bytes), { mergePages: true });
  // Normalise non-breaking/narrow spaces used by Intl number formatting.
  return { text: text.replace(/[\s  ]+/g, " "), pages: totalPages, bytes };
}

describe("document PDF rendering", { timeout: 30_000 }, () => {
  it("renders a valid PDF with metadata and the full invoice content", async () => {
    const model = sampleModels("en").invoice!;
    const { text, bytes, pages } = await pdfText(model);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pages).toBe(1);

    const meta = await getMeta(await getDocumentProxy(new Uint8Array(bytes)));
    expect(meta.info).toMatchObject({
      Title: "Invoice INV-2026-0001",
      Author: "Example Workwear SIA",
      Producer: "ALVOXIS Flow",
    });

    for (const expected of [
      "Invoice",
      "INV-2026-0001",
      "Example Workwear SIA",
      "Sample Shipping Agency Ltd",
      "PO-SAMPLE-001",
      "Winter jacket, size L",
      "€1,202.50", // net
      "€220.50", // tax
      "€1,423.00", // gross
      "Exempt",
      "TAX NOTES",
      "SELLER",
      "Explanatory note entered by the user (sample).",
      "Please pay by 16/03/2026",
      "LV80 BANK 0000 4351 9500 1",
      "Document fingerprint 0000000000000000",
      "Page 1 of 1",
    ]) {
      expect(text, expected).toContain(expected);
    }
  });

  it("uses the document language for labels, dates and number formats", async () => {
    const lv = (await pdfText(sampleModels("lv").invoice!)).text;
    expect(lv).toContain("Rēķins");
    expect(lv).toContain("IZRAKSTĪŠANAS DATUMS"); // small-caps label
    expect(lv).toContain("02.03.2026");
    expect(lv).toContain("1423,00 €"); // CLDR: Latvian does not group 4-digit numbers

    const ru = (await pdfText(sampleModels("ru").invoice!)).text;
    expect(ru).toContain("Счёт");
    expect(ru).toContain("Освобождено");
    expect(ru).toContain("Просим оплатить до 16.03.2026");
  });

  it("renders credit notes with the reference to the original invoice and negative totals", async () => {
    const { text } = await pdfText(sampleModels("lv")["credit-note"]!);
    expect(text).toContain("Kredītrēķins");
    expect(text).toContain("CN-2026-0001");
    expect(text).toContain("Kredītrēķins rēķinam INV-2026-0001, 02.03.2026");
    expect(text).toContain("Kopā kreditēts");
    expect(text).toContain("-102,60 €");
    expect(text).not.toContain("MAKSĀJUMA REKVIZĪTI"); // no payment request on a credit note
  });

  it("renders delivery notes without prices and with signature fields", async () => {
    const { text } = await pdfText(sampleModels("ru")["delivery-note"]!);
    expect(text).toContain("Накладная");
    expect(text).toContain("Связанный счёт: INV-2026-0001 от 02.03.2026");
    expect(text).toContain("Общий вес, кг");
    expect(text).toContain("Получил");
    expect(text).not.toMatch(/€|EUR/);
    // Lines use different units, so no meaningless total quantity is printed.
    expect(text).not.toContain("Общее количество");
  });

  it("renders proformas with validity date and without a due-date payment request", async () => {
    const { text } = await pdfText(sampleModels("et").proforma!);
    expect(text).toContain("Ettemaksuarve");
    expect(text).toContain("KEHTIB KUNI");
    expect(text).not.toContain("Palume tasuda");
  });

  it("prints converted totals with the rate, its date and source, in the document's format", async () => {
    const { text } = await pdfText(sampleModels("et")["invoice-with-rate"]!);
    expect(text).toContain("1 EUR = 4,2500 PLN");
    expect(text).toContain("01.03.2026");
    expect(text).toContain("kurss sisestatud käsitsi");
    expect(text).toContain("6047,76 PLN");
    expect(text).toContain("1423,00 €"); // the document total stays in EUR
  });

  it("marks drafts clearly and prints no number", async () => {
    const { text } = await pdfText(sampleModels("en")["invoice-draft"]!);
    expect(text).toContain("DRAFT — not issued");
    expect(text).not.toContain("INV-2026-0001");
  });

  it("paginates long documents with page numbers", async () => {
    const base = sampleInvoice("en");
    const doc: DocumentDraft = {
      ...base,
      lines: Array.from({ length: 120 }, (_, i) => ({
        ...base.lines[0]!,
        id: `l${i}`,
        description: `Line ${i + 1}`,
      })),
    };
    const { text, pages } = await pdfText({
      document: doc,
      status: "issued",
      number: "INV-2026-0099",
      totals: calculateTotals(doc),
    });
    expect(pages).toBeGreaterThan(1);
    expect(text).toContain(`Page 1 of ${pages}`);
    expect(text).toContain(`Page ${pages} of ${pages}`);
    expect(text).toContain("Line 120");
  });

  it("renders the same issued snapshot deterministically (text content)", async () => {
    const model = sampleModels("en").invoice!;
    expect((await pdfText(model)).text).toBe((await pdfText(model)).text);
  });
});
