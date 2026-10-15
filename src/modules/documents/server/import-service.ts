import "server-only";
import { createHash } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type Database, type DbOrTx } from "@/server/db/client";
import { documents } from "@/server/db/schema";
import { extractLayout } from "../import/extract";
import { findDuplicates } from "../import/duplicates";
import { parseInvoiceLayout } from "../import/parse-invoice";
import { type ImportReview } from "../import/review";
import { type ImportDecisions, toDraftInput } from "../import/to-draft";
import { createDraft } from "./document-service";
import { DocumentStateError } from "./errors";

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

function assertPdf(bytes: Uint8Array) {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new DocumentStateError(
      "import.file.size",
      `PDF must be between 1 byte and ${MAX_IMPORT_BYTES / 1024 / 1024} MB`,
    );
  }
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") {
    throw new DocumentStateError("import.file.notPdf", "File is not a PDF");
  }
}

async function analyse(db: DbOrTx, companyId: string, bytes: Uint8Array): Promise<ImportReview> {
  assertPdf(bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  let review: ImportReview;
  try {
    // pdf.js may detach the buffer it is given; pass a copy.
    review = parseInvoiceLayout(await extractLayout(new Uint8Array(bytes)), sha);
  } catch {
    throw new DocumentStateError("import.file.unreadable", "The PDF could not be read");
  }

  const conditions = [eq(documents.sourceFileSha256, sha)];
  if (review.number.value)
    conditions.push(sql`lower(${documents.number}) = lower(${review.number.value})`);
  if (review.issueDate.value) conditions.push(eq(documents.issueDate, review.issueDate.value));
  const existing = await db
    .select({
      id: documents.id,
      type: documents.type,
      number: documents.number,
      issueDate: documents.issueDate,
      currency: documents.currency,
      grossTotal: documents.grossTotal,
      sellerName: sql<string | null>`${documents.seller}->>'name'`,
      buyerName: sql<string | null>`${documents.buyer}->>'name'`,
      sourceFileSha256: documents.sourceFileSha256,
    })
    .from(documents)
    .where(and(eq(documents.companyId, companyId), or(...conditions)))
    .limit(50);

  review.duplicates = findDuplicates(review, existing);
  if (review.duplicates.length) {
    review.flags.push({
      code: "duplicate.possible",
      severity: review.duplicates.some((d) => d.strength !== "possible") ? "warning" : "info",
      field: "duplicates",
    });
  }
  return review;
}

/**
 * Reads a PDF and returns extracted fields for review. Creates nothing. Only the file hash and
 * the finding codes are audited — never the document content.
 */
export async function previewPdfImport(
  db: Database,
  actor: Actor,
  companyId: string,
  bytes: Uint8Array,
): Promise<ImportReview> {
  await requireCompanyAccess(db, actor, companyId, "documents.create");
  const review = await analyse(db, companyId, bytes);
  await recordAudit(db, {
    companyId,
    actorUserId: actor.userId,
    action: "document.import_previewed",
    entityType: "import",
    entityId: review.fileSha256,
    metadata: {
      pages: review.pageCount,
      flags: review.flags.map((f) => f.code),
      duplicates: review.duplicates.length,
    },
  });
  return review;
}

/**
 * Creates a DRAFT from a reviewed import. The file is analysed again on the server, so the
 * review cannot be tampered with by the client; the user's decisions must resolve every finding.
 */
export async function createDraftFromImport(
  db: Database,
  actor: Actor,
  companyId: string,
  bytes: Uint8Array,
  decisions: ImportDecisions,
) {
  await requireCompanyAccess(db, actor, companyId, "documents.create");
  const review = await analyse(db, companyId, bytes);
  const input = toDraftInput(review, decisions);
  return createDraft(db, actor, companyId, input, {
    sourceFileSha256: review.fileSha256,
    auditAction: "document.draft_created_from_import",
  });
}
