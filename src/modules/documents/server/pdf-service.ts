import "server-only";
import { type Actor } from "@/server/auth/authorization";
import { type DbOrTx } from "@/server/db/client";
import { type DocumentDraft, type DocumentTotals } from "../domain/types";
import { type DocumentPdfModel } from "../pdf/document-pdf";
import { renderDocumentPdf } from "../pdf/render";
import { getDocument } from "./document-service";

/** Characters kept in file names; everything else (quotes, slashes, spaces…) becomes "_". */
const SAFE = /[^A-Za-z0-9._-]+/g;

/**
 * The PDF of a document (documents.view, through getDocument → requireCompanyAccess). Issued
 * documents are rendered only from their frozen snapshot — content, totals, number and hash as
 * issued — never from the current company profile or draft rows. Drafts render their current
 * content with the "not issued" watermark and no number.
 */
export async function getDocumentPdf(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  documentId: string,
): Promise<{ bytes: Buffer; filename: string }> {
  const stored = await getDocument(db, actor, companyId, documentId);
  let model: DocumentPdfModel;
  if (stored.status === "issued") {
    // getDocument serves issued documents from `documents.snapshot`; take every field from it.
    const snapshot = stored.draft as DocumentDraft & {
      number: string;
      totals: DocumentTotals | null;
      contentHash: string;
    };
    model = {
      document: snapshot,
      status: "issued",
      number: snapshot.number,
      totals: snapshot.totals,
      contentHash: snapshot.contentHash,
    };
  } else {
    model = {
      document: stored.draft,
      status: "draft",
      number: null,
      totals: stored.totals,
      contentHash: null,
    };
  }
  const base =
    model.status === "issued" && model.number
      ? model.number
      : `draft-${stored.draft.type}-${documentId.slice(0, 8)}`;
  return {
    bytes: await renderDocumentPdf(model),
    filename: `${base.replace(SAFE, "_").replace(/^[._]+/, "") || "document"}.pdf`,
  };
}
