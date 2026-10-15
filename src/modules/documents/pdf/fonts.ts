import path from "node:path";
import { Font } from "@react-pdf/renderer";

/**
 * Noto Sans (SIL OFL 1.1, see assets/fonts/OFL.txt) covers Latin incl. Latvian, Lithuanian,
 * Estonian and Polish diacritics, plus Cyrillic. The built-in PDF fonts do not.
 */
export const PDF_FONT_FAMILY = "NotoSans";
let registered = false;

export function fontsDirectory(): string {
  return process.env.PDF_FONTS_DIR ?? path.join(process.cwd(), "assets", "fonts");
}

export function registerPdfFonts(): void {
  if (registered) return;
  const dir = fontsDirectory();
  Font.register({
    family: PDF_FONT_FAMILY,
    fonts: [
      { src: path.join(dir, "NotoSans-Regular.ttf"), fontWeight: 400 },
      { src: path.join(dir, "NotoSans-SemiBold.ttf"), fontWeight: 600 },
      { src: path.join(dir, "NotoSans-Bold.ttf"), fontWeight: 700 },
    ],
  });
  // Never hyphenate names, numbers or IBANs.
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}
