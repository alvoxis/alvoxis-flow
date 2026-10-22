/**
 * The company's accent colour for its document PDFs, chosen from a fixed, tested palette (never a
 * free-form colour, CSS or HTML). The accent only colours headings, thin rules, the totals and
 * the due-date block; the page stays white and body text stays dark. Every accent has at least
 * 4.5:1 contrast against white and against its own tint (WCAG AA for normal text, see the tests).
 * It never affects document content, totals or numbering.
 */
export const PDF_ACCENTS = ["navy", "graphite", "blue", "teal", "green", "burgundy"] as const;
export type PdfAccent = (typeof PDF_ACCENTS)[number];

/** Safe default for new companies and for any missing or unknown stored value. */
export const DEFAULT_PDF_ACCENT: PdfAccent = "navy";

export interface PdfAccentColors {
  /** Headings, rules, total and due-date text. */
  accent: string;
  /** Very light tint for small highlighted areas (due-date block, credit-note reference). */
  tint: string;
}

export const PDF_ACCENT_COLORS: Record<PdfAccent, PdfAccentColors> = {
  navy: { accent: "#1f3a5f", tint: "#eef2f7" },
  graphite: { accent: "#374151", tint: "#f1f2f4" },
  blue: { accent: "#1d4ed8", tint: "#eef3fd" },
  teal: { accent: "#0f766e", tint: "#ecf6f5" },
  green: { accent: "#166534", tint: "#edf5ef" },
  burgundy: { accent: "#8b1e3f", tint: "#f8eef1" },
};

export function isPdfAccent(value: unknown): value is PdfAccent {
  return typeof value === "string" && (PDF_ACCENTS as readonly string[]).includes(value);
}

/** The palette entry for a stored value; anything missing or unknown falls back to the default. */
export function resolvePdfAccent(value: unknown): PdfAccentColors {
  return PDF_ACCENT_COLORS[isPdfAccent(value) ? value : DEFAULT_PDF_ACCENT];
}
