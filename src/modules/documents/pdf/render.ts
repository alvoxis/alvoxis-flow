import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { DocumentPdf, type DocumentPdfModel } from "./document-pdf";
import { registerPdfFonts } from "./fonts";

/**
 * Renders a document to PDF bytes (server-side). Issued documents must be rendered from their
 * frozen snapshot, so the output can be regenerated identically at any time.
 */
export async function renderDocumentPdf(model: DocumentPdfModel): Promise<Buffer> {
  registerPdfFonts();
  // DocumentPdf returns a <Document> element, as renderToBuffer expects.
  return renderToBuffer(
    createElement(DocumentPdf, { model }) as Parameters<typeof renderToBuffer>[0],
  );
}
