import { getDocumentProxy } from "unpdf";

/**
 * Text-layer extraction that preserves the visual layout: text items are grouped into lines by
 * their baseline (y) and ordered left-to-right (x). Wide horizontal gaps become a column
 * separator (two or more spaces), so table rows stay together. Scanned PDFs without a text layer
 * yield no lines — OCR is out of scope and such files are reported as unreadable.
 */
export interface LayoutPage {
  lines: string[];
}

interface Item {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MAX_IMPORT_PAGES = 20;

export async function extractLayout(bytes: Uint8Array): Promise<LayoutPage[]> {
  const pdf = await getDocumentProxy(bytes);
  const pages: LayoutPage[] = [];
  const count = Math.min(pdf.numPages, MAX_IMPORT_PAGES);
  for (let p = 1; p <= count; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items: Item[] = [];
    for (const raw of content.items) {
      if (!("str" in raw) || !raw.str.trim()) continue;
      const [, , , d, x, y] = raw.transform as number[];
      items.push({
        str: raw.str,
        x: x!,
        y: y!,
        width: raw.width,
        height: Math.abs(d ?? raw.height) || raw.height,
      });
    }
    pages.push({ lines: toLines(items) });
  }
  return pages;
}

function toLines(items: Item[]): string[] {
  // Top of the page first (PDF y grows upwards).
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Item[][] = [];
  for (const item of sorted) {
    const tolerance = Math.max(2, item.height * 0.4);
    const row = rows.find((r) => Math.abs(r[0]!.y - item.y) <= tolerance);
    if (row) row.push(item);
    else rows.push([item]);
  }
  return rows
    .map((row) => {
      row.sort((a, b) => a.x - b.x);
      let line = "";
      let end = -Infinity;
      for (const it of row) {
        const gap = it.x - end;
        const charWidth = it.str.length ? it.width / it.str.length : 4;
        if (line)
          line += gap > Math.max(charWidth * 2.5, 8) ? "   " : gap > charWidth * 0.25 ? " " : "";
        line += it.str;
        end = it.x + it.width;
      }
      return line.replace(/[ \t]+$/g, "");
    })
    .filter((l) => l.trim().length > 0);
}
