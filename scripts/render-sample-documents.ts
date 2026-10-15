/**
 * Renders the FICTITIOUS sample documents to PDF for visual review:
 *   pnpm docs:samples [outDir] [language]
 * Output defaults to ./tmp/sample-documents (git-ignored).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LOCALES, type AppLocale } from "../src/i18n/config";
import { renderDocumentPdf } from "../src/modules/documents/pdf/render";
import { sampleModels } from "../src/modules/documents/sample/sample-documents";

async function main() {
  const outDir = path.resolve(process.argv[2] ?? "tmp/sample-documents");
  const languages = (process.argv[3] ? [process.argv[3]] : LOCALES) as AppLocale[];
  await mkdir(outDir, { recursive: true });
  for (const lang of languages) {
    for (const [name, model] of Object.entries(sampleModels(lang))) {
      const file = path.join(outDir, `${name}.${lang}.pdf`);
      await writeFile(file, await renderDocumentPdf(model));
      console.log(file);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
