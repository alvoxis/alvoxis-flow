import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PDF_ACCENT,
  isPdfAccent,
  PDF_ACCENT_COLORS,
  PDF_ACCENTS,
  resolvePdfAccent,
} from "@/lib/pdf-accent";

/** WCAG 2.x relative luminance and contrast ratio. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("PDF accent palette", () => {
  it("offers the agreed colours with a dark-blue default", () => {
    expect(PDF_ACCENTS).toEqual(["navy", "graphite", "blue", "teal", "green", "burgundy"]);
    expect(DEFAULT_PDF_ACCENT).toBe("navy");
  });

  it.each(PDF_ACCENTS)("%s is a valid hex colour readable on white and on its tint", (accent) => {
    const { accent: color, tint } = PDF_ACCENT_COLORS[accent];
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect(tint).toMatch(/^#[0-9a-f]{6}$/);
    // WCAG AA for normal-size text (accent text sits on white and inside the tinted blocks).
    expect(contrast(color, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color, tint)).toBeGreaterThanOrEqual(4.5);
    // The tint stays a light wash: dark body text on it keeps a high contrast.
    expect(contrast("#1f2328", tint)).toBeGreaterThanOrEqual(12);
  });

  it("falls back to the default for missing, unknown or unsafe values", () => {
    const fallback = PDF_ACCENT_COLORS.navy;
    for (const value of [undefined, null, "", "red", "#ff0000", "NAVY", "navy;}", 42, {}]) {
      expect(isPdfAccent(value)).toBe(false);
      expect(resolvePdfAccent(value)).toBe(fallback);
    }
    expect(resolvePdfAccent("teal")).toBe(PDF_ACCENT_COLORS.teal);
  });

  it("the database check constraint allows exactly the palette values", () => {
    const sql = readFileSync(path.resolve("drizzle/0013_company_pdf_accent.sql"), "utf8");
    const allowed = /in \(([^)]*)\)/
      .exec(sql)![1]!
      .match(/'([a-z]+)'/g)!
      .map((v) => v.slice(1, -1));
    expect(allowed).toEqual([...PDF_ACCENTS]);
    expect(sql).toContain(`DEFAULT '${DEFAULT_PDF_ACCENT}' NOT NULL`);
  });
});
