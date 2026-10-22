import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/i18n/config";
import { PDF_ACCENT_COLORS, PDF_ACCENTS, type PdfAccent } from "@/lib/pdf-accent";
import { calculateTotals, type DocumentDraft } from "@/modules/documents/domain";
import { type DocumentPdfModel } from "@/modules/documents/pdf/document-pdf";
import { docMoney } from "@/modules/documents/pdf/format";
import { renderDocumentPdf } from "@/modules/documents/pdf/render";
import {
  sampleInvoice,
  sampleLongInvoice,
  sampleModels,
} from "@/modules/documents/sample/sample-documents";

/**
 * Layout checks on the rendered PDF itself (not just "a file was produced"): the positions of all
 * text runs (pdf.js) must stay inside the page margins and never overlap; no page may be empty;
 * the accent colour must be the one the company chose. Sample data is FICTITIOUS.
 */

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 40;

interface Run {
  str: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

async function inspect(model: DocumentPdfModel) {
  const bytes = await renderDocumentPdf(model);
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pages: { width: number; height: number; runs: Run[]; colors: Set<string> }[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const [, , width, height] = page.view as [number, number, number, number];
    const { items } = await page.getTextContent();
    const runs = (items as { str: string; transform: number[]; width: number }[])
      .filter((i) => i.str.trim() !== "")
      .map((i) => {
        const size = i.transform[3]!;
        const [x, y] = [i.transform[4]!, i.transform[5]!];
        // Glyph box from the baseline: descenders below, cap height above.
        return { str: i.str, x0: x, x1: x + i.width, y0: y - 0.22 * size, y1: y + 0.75 * size };
      });
    // Colours set by fill/stroke operators (pdf.js reports them as hex strings).
    const ops = await page.getOperatorList();
    const colors = new Set<string>();
    for (const args of ops.argsArray as unknown[][])
      for (const a of args ?? [])
        if (typeof a === "string" && /^#[0-9a-f]{6}$/.test(a)) colors.add(a);
    pages.push({ width, height, runs, colors });
  }
  const { text } = await extractText(new Uint8Array(bytes), { mergePages: true });
  return { pages, text: text.replace(/[\s  ]+/g, " ") };
}

/** Minimum gap between two text runs on the same line (table cells have 3 + 3 pt padding). */
const MIN_GAP = 2;

/** Two runs drawn over each other, or so close on one line that they read as one. */
function collides(a: Run, b: Run): boolean {
  const dy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (dy <= 0.5) return false;
  const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
  return gap < MIN_GAP;
}

/** Problems on a page: text outside the margins, or text runs overlapping or touching. */
function layoutProblems(page: Awaited<ReturnType<typeof inspect>>["pages"][number]): string[] {
  const problems: string[] = [];
  for (const r of page.runs) {
    if (r.x0 < MARGIN - 0.5 || r.x1 > page.width - MARGIN + 0.5)
      problems.push(`outside the side margins: "${r.str}" ${r.x0.toFixed(1)}–${r.x1.toFixed(1)}`);
    if (r.y0 < 0 || r.y1 > page.height) problems.push(`off the page: "${r.str}"`);
  }
  for (let i = 0; i < page.runs.length; i++)
    for (let j = i + 1; j < page.runs.length; j++)
      if (collides(page.runs[i]!, page.runs[j]!))
        problems.push(`overlap or touching: "${page.runs[i]!.str}" × "${page.runs[j]!.str}"`);
  return problems;
}

function withAccent(model: DocumentPdfModel, accent: PdfAccent | null | undefined | string) {
  return { ...model, accent: accent as PdfAccent };
}

describe("layout checker", () => {
  const run = (str: string, x0: number, x1: number, y = 500): Run => ({
    str,
    x0,
    x1,
    y0: y - 2,
    y1: y + 6,
  });
  const page = (runs: Run[]) => ({
    width: A4.width,
    height: A4.height,
    runs,
    colors: new Set<string>(),
  });

  it("accepts separate runs and flags overlapping, touching or out-of-margin text", () => {
    expect(
      layoutProblems(page([run("a", 50, 100), run("b", 110, 150), run("c", 50, 100, 480)])),
    ).toEqual([]);
    expect(layoutProblems(page([run("a", 50, 100), run("b", 90, 150)]))).toHaveLength(1); // overlap
    expect(layoutProblems(page([run("a", 50, 100), run("b", 101, 150)]))).toHaveLength(1); // touching
    expect(layoutProblems(page([run("a", 20, 100)]))).toHaveLength(1); // left margin
    expect(layoutProblems(page([run("a", 500, 570)]))).toHaveLength(1); // right margin
  });
});

describe("document PDF layout", { timeout: 120_000 }, () => {
  it("is A4 and keeps every text run inside the margins without overlaps, in all five languages", async () => {
    for (const locale of LOCALES) {
      for (const [name, model] of Object.entries(sampleModels(locale))) {
        const { pages } = await inspect(model);
        for (const [n, page] of pages.entries()) {
          expect([page.width, page.height].map(Math.round), `${name}.${locale}`).toEqual([
            Math.round(A4.width),
            Math.round(A4.height),
          ]);
          expect(layoutProblems(page), `${name}.${locale} page ${n + 1}`).toEqual([]);
          // No blank pages: every page has content besides the footer and page number.
          expect(page.runs.length, `${name}.${locale} page ${n + 1}`).toBeGreaterThan(4);
        }
      }
    }
  });

  it("spreads long documents over several pages: long names wrap, nothing is cut or lost", async () => {
    for (const locale of LOCALES) {
      const doc = sampleLongInvoice(locale, 60);
      const totals = calculateTotals(doc);
      const { pages, text } = await inspect({
        document: doc,
        status: "issued",
        number: "INV-2026-0100",
        totals,
      });
      expect(pages.length, locale).toBeGreaterThan(1);
      for (const [n, page] of pages.entries()) {
        expect(layoutProblems(page), `${locale} page ${n + 1}`).toEqual([]);
        expect(page.runs.length, `${locale} page ${n + 1}`).toBeGreaterThan(4);
      }
      // Every line made it into the PDF, and the totals are printed exactly once.
      for (let i = 1; i <= 60; i++)
        expect(text, `${locale} line ${i}`).toContain(`Sample item ${i}:`);
      const gross = docMoney(totals.grossTotal, doc.currency, locale).replace(/[\s  ]+/g, " ");
      expect(text.split(gross).length - 1, locale).toBe(2); // due-date block + grand total
      expect(text).toContain("Industrial Workwear Manufacturing");
    }
  });

  it("wraps long single words in narrow columns instead of running into the next one", async () => {
    const base = sampleInvoice("et");
    const doc: DocumentDraft = {
      ...base,
      lines: base.lines.map((l) => ({
        ...l,
        description: `${l.description} ARTIKKEL-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ`,
        taxCategory: { ...l.taxCategory!, kind: "reverse_charge", ratePercent: "0" },
      })),
    };
    const { pages } = await inspect({
      document: doc,
      status: "issued",
      number: "INV-2026-0003",
      totals: calculateTotals(doc),
    });
    for (const page of pages) expect(layoutProblems(page)).toEqual([]);
  });

  it("prints the totals and taxes exactly as calculated by the domain", async () => {
    const doc = sampleLongInvoice("en", 12);
    const totals = calculateTotals(doc);
    const { text } = await inspect({ document: doc, status: "issued", number: "X-1", totals });
    for (const amount of [totals.netTotal, totals.taxTotal, totals.grossTotal])
      expect(text).toContain(docMoney(amount, "EUR", "en"));
    for (const r of totals.taxSummary) {
      expect(text).toContain(docMoney(r.taxableAmount, "EUR", "en"));
      expect(text).toContain(docMoney(r.taxAmount, "EUR", "en"));
    }
    for (const l of totals.lines) expect(text).toContain(docMoney(l.net, "EUR", "en"));
  });

  it("leaves out the blocks of optional data that is missing", async () => {
    const base = sampleInvoice("en");
    const doc: DocumentDraft = {
      ...base,
      dueDate: undefined,
      buyerReference: undefined,
      paymentTerms: undefined,
      notes: undefined,
      footer: undefined,
      bankAccounts: [],
      seller: { name: base.seller.name },
      buyer: { name: base.buyer.name },
    };
    const { pages, text } = await inspect({
      document: doc,
      status: "issued",
      number: "INV-2026-0004",
      totals: calculateTotals(doc),
    });
    for (const absent of [
      "DUE DATE",
      "Amount due",
      "ORDER REFERENCE",
      "PAYMENT DETAILS",
      "IBAN",
      "Reg. No.",
      "VAT No.",
      "E-mail",
    ])
      expect(text, absent).not.toContain(absent);
    expect(text).not.toMatch(/(?<!TAX )NOTES/); // the notes block (tax notes stay)
    for (const present of ["SELLER", "BUYER", "ISSUE DATE", "INV-2026-0004", "Total"])
      expect(text).toContain(present);
    expect(layoutProblems(pages[0]!)).toEqual([]);
  });

  it.each(PDF_ACCENTS)("draws headings, rules and the total in the %s accent", async (accent) => {
    const { pages } = await inspect(withAccent(sampleModels("en").invoice!, accent));
    const { accent: color, tint } = PDF_ACCENT_COLORS[accent];
    expect(pages[0]!.colors).toContain(color);
    expect(pages[0]!.colors).toContain(tint); // the due-date block
    // No other accent leaks in.
    for (const other of PDF_ACCENTS.filter((a) => a !== accent))
      expect(pages[0]!.colors).not.toContain(PDF_ACCENT_COLORS[other].accent);
  });

  it("uses the default accent when the value is missing, unknown or unsafe", async () => {
    const navy = PDF_ACCENT_COLORS.navy.accent;
    for (const value of [undefined, null, "", "#ff0000", "red; background: url(x)"]) {
      const { pages } = await inspect(withAccent(sampleModels("en").invoice!, value));
      expect(pages[0]!.colors, String(value)).toContain(navy);
      expect(pages[0]!.colors).not.toContain("#ff0000");
    }
  });

  it("the accent changes only colours: the text content is identical", async () => {
    const model = sampleModels("lv").invoice!;
    const base = (await inspect(withAccent(model, "navy"))).text;
    for (const accent of PDF_ACCENTS)
      expect((await inspect(withAccent(model, accent))).text, accent).toBe(base);
  });
});
