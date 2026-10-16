import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, ne } from "drizzle-orm";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type Database, type DbOrTx } from "@/server/db/client";
import { documentLines, documents } from "@/server/db/schema";
import { tenantFilter } from "@/server/tenancy/scope";
import { calculateTotals } from "../domain/calculate";
import {
  assertCreditWithinRemaining,
  buildCreditNote,
  buildDeliveryNoteFromInvoice,
  buildFullCreditNote,
  convertProformaToInvoice,
  type CreditRequest,
} from "../domain/derive";
import { parseDraftInput } from "../domain/schema";
import { canonicalJson } from "../domain/snapshot";
import {
  type DocumentDraft,
  type DocumentTotals,
  type IssuedDocument,
  isPricedDocument,
} from "../domain/types";
import { hasBlockingIssues, validateDocument, type ValidationIssue } from "../domain/validation";
import {
  DocumentNotFoundError,
  DocumentStateError,
  DocumentValidationError,
  DocumentVersionConflictError,
} from "./errors";
import { draftToRowValues, lineToRowValues, rowToDraft } from "./mapping";
import { allocateDocumentNumber } from "./numbering-service";
import {
  applySellerIdentity,
  applySellerIdentityToInput,
  loadSellerIdentity,
} from "./seller-profile";

export interface StoredDocument {
  id: string;
  companyId: string;
  status: "draft" | "issued";
  number: string | null;
  version: number;
  draft: DocumentDraft;
  totals: DocumentTotals | null;
  contentHash: string | null;
  /** Validation findings for drafts (warnings and errors), empty for issued documents. */
  issues: ValidationIssue[];
}

async function loadRow(db: DbOrTx, companyId: string, documentId: string, forUpdate = false) {
  const ctxFilter = and(eq(documents.id, documentId), eq(documents.companyId, companyId));
  const q = db.select().from(documents).where(ctxFilter).limit(1);
  const [row] = forUpdate ? await q.for("update") : await q;
  if (!row) throw new DocumentNotFoundError();
  const lines = await db
    .select()
    .from(documentLines)
    .where(eq(documentLines.documentId, row.id))
    .orderBy(asc(documentLines.position));
  let related: { number: string; issueDate: string } | undefined;
  if (row.relatedDocumentId) {
    const [rel] = await db
      .select({ number: documents.number, issueDate: documents.issueDate })
      .from(documents)
      .where(and(eq(documents.id, row.relatedDocumentId), eq(documents.companyId, companyId)));
    if (rel?.number) related = { number: rel.number, issueDate: rel.issueDate };
  }
  return { row, lines, draft: rowToDraft(row, lines, related) };
}

function toStored(loaded: Awaited<ReturnType<typeof loadRow>>): StoredDocument {
  const { row, draft } = loaded;
  const issuedTotals = row.snapshot
    ? ((row.snapshot as { totals?: DocumentTotals | null }).totals ?? null)
    : null;
  return {
    id: row.id,
    companyId: row.companyId,
    status: row.status,
    number: row.number,
    version: row.version,
    // Issued documents are always served from their frozen snapshot.
    draft: row.status === "issued" && row.snapshot ? (row.snapshot as DocumentDraft) : draft,
    totals:
      row.status === "issued"
        ? issuedTotals
        : isPricedDocument(draft.type) && !hasBlockingIssues(validateDocument(draft))
          ? calculateTotals(draft)
          : null,
    contentHash: row.contentHash,
    issues: row.status === "draft" ? validateDocument(draft) : [],
  };
}

async function insertDraft(
  tx: DbOrTx,
  actor: Actor,
  companyId: string,
  draft: DocumentDraft,
  action: string,
  opts: { seriesId?: string; sourceFileSha256?: string } = {},
) {
  // Every new draft (manual, derived, credit note, import) shows the company profile as seller.
  draft = {
    ...draft,
    seller: applySellerIdentity(draft.seller, await loadSellerIdentity(tx, companyId)),
  };
  const [row] = await tx
    .insert(documents)
    .values({
      companyId,
      ...draftToRowValues(draft),
      seriesId: opts.seriesId ?? null,
      sourceFileSha256: opts.sourceFileSha256 ?? null,
      createdByUserId: actor.userId,
    })
    .returning({ id: documents.id });
  if (draft.lines.length) {
    await tx
      .insert(documentLines)
      .values(draft.lines.map((l, i) => lineToRowValues(l, i + 1, companyId, row!.id)));
  }
  await recordAudit(tx, {
    companyId,
    actorUserId: actor.userId,
    action,
    entityType: "document",
    entityId: row!.id,
    metadata: {
      type: draft.type,
      relation: draft.relation
        ? { kind: draft.relation.kind, documentId: draft.relation.documentId }
        : null,
    },
  });
  return row!.id;
}

/** Creates a draft from untrusted input. Credit notes must use createCreditNoteDraft. */
export async function createDraft(
  db: Database,
  actor: Actor,
  companyId: string,
  input: unknown,
  opts: { seriesId?: string; sourceFileSha256?: string; auditAction?: string } = {},
) {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "documents.create");
    // The seller comes from the company profile; a client cannot supply another identity.
    const draft = parseDraftInput(
      applySellerIdentityToInput(input, await loadSellerIdentity(tx, companyId)),
      randomUUID,
    );
    if (draft.type === "credit_note") {
      throw new DocumentStateError(
        "creditNote.useDedicatedFlow",
        "Credit notes are created from an issued invoice",
      );
    }
    const id = await insertDraft(
      tx,
      actor,
      companyId,
      draft,
      opts.auditAction ?? "document.draft_created",
      opts,
    );
    return toStored(await loadRow(tx, companyId, id));
  });
}

/**
 * Replaces a draft's content. `expectedVersion` prevents lost updates; every saved version is
 * recorded in the audit log. Document type and relations cannot be changed.
 */
export async function updateDraft(
  db: Database,
  actor: Actor,
  companyId: string,
  documentId: string,
  expectedVersion: number,
  input: unknown,
) {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "documents.create");
    const current = await loadRow(tx, companyId, documentId, true);
    if (current.row.status !== "draft")
      throw new DocumentStateError("document.notDraft", "Issued documents cannot be edited");
    if (current.row.version !== expectedVersion) throw new DocumentVersionConflictError();

    const next = parseDraftInput(
      applySellerIdentityToInput(input, await loadSellerIdentity(tx, companyId)),
      randomUUID,
    );
    if (next.type !== current.row.type)
      throw new DocumentStateError("document.typeChange", "Document type cannot change");
    // Credit-note lines must keep pointing at the original invoice lines.
    const lines =
      current.row.type === "credit_note"
        ? next.lines.map((l, i) => ({ ...l, sourceLineId: current.draft.lines[i]?.sourceLineId }))
        : next.lines;

    await tx.delete(documentLines).where(eq(documentLines.documentId, documentId));
    if (lines.length)
      await tx
        .insert(documentLines)
        .values(lines.map((l, i) => lineToRowValues(l, i + 1, companyId, documentId)));
    const {
      relationKind: _rk,
      relatedDocumentId: _rd,
      type: _t,
      ...values
    } = draftToRowValues(next);
    await tx
      .update(documents)
      .set({ ...values, version: expectedVersion + 1 })
      .where(and(eq(documents.id, documentId), eq(documents.companyId, companyId)));
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "document.draft_updated",
      entityType: "document",
      entityId: documentId,
      metadata: { version: expectedVersion + 1 },
    });
    return toStored(await loadRow(tx, companyId, documentId));
  });
}

export async function deleteDraft(
  db: Database,
  actor: Actor,
  companyId: string,
  documentId: string,
) {
  await db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "documents.create");
    const { row } = await loadRow(tx, companyId, documentId, true);
    if (row.status !== "draft")
      throw new DocumentStateError("document.notDraft", "Issued documents cannot be deleted");
    await tx
      .delete(documents)
      .where(and(eq(documents.id, documentId), eq(documents.companyId, companyId)));
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "document.draft_deleted",
      entityType: "document",
      entityId: documentId,
    });
  });
}

export async function getDocument(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  documentId: string,
): Promise<StoredDocument> {
  await requireCompanyAccess(db, actor, companyId, "documents.view");
  return toStored(await loadRow(db, companyId, documentId));
}

export async function listDocuments(db: DbOrTx, actor: Actor, companyId: string) {
  const ctx = await requireCompanyAccess(db, actor, companyId, "documents.view");
  return db
    .select({
      id: documents.id,
      type: documents.type,
      status: documents.status,
      number: documents.number,
      issueDate: documents.issueDate,
      currency: documents.currency,
      grossTotal: documents.grossTotal,
    })
    .from(documents)
    .where(tenantFilter(documents.companyId, ctx))
    .orderBy(asc(documents.issueDate));
}

async function loadIssued(
  tx: DbOrTx,
  companyId: string,
  documentId: string,
): Promise<IssuedDocument> {
  const { row } = await loadRow(tx, companyId, documentId);
  if (row.status !== "issued" || !row.snapshot)
    throw new DocumentStateError("source.notIssued", "Source document is not issued");
  return row.snapshot as unknown as IssuedDocument;
}

/** Credit-note lines already ISSUED against an invoice (optionally excluding one document). */
async function issuedCreditLines(
  tx: DbOrTx,
  companyId: string,
  invoiceId: string,
  excludeId?: string,
) {
  const notes = await tx
    .select({ id: documents.id, snapshot: documents.snapshot })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, companyId),
        eq(documents.relatedDocumentId, invoiceId),
        eq(documents.type, "credit_note"),
        eq(documents.status, "issued"),
        ...(excludeId ? [ne(documents.id, excludeId)] : []),
      ),
    );
  return notes.flatMap((n) => (n.snapshot as unknown as IssuedDocument).lines);
}

export async function createCreditNoteDraft(
  db: Database,
  actor: Actor,
  companyId: string,
  invoiceId: string,
  requests: readonly CreditRequest[] | "full",
  params: { issueDate: string; language?: DocumentDraft["language"] },
) {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "documents.create");
    const original = await loadIssued(tx, companyId, invoiceId);
    const previous = await issuedCreditLines(tx, companyId, invoiceId);
    const derive = {
      newLineId: randomUUID,
      issueDate: params.issueDate,
      language: params.language,
    };
    const draft =
      requests === "full"
        ? buildFullCreditNote(original, previous, derive)
        : buildCreditNote(original, requests, previous, derive);
    const id = await insertDraft(tx, actor, companyId, draft, "document.credit_note_draft_created");
    return toStored(await loadRow(tx, companyId, id));
  });
}

export async function deriveDraft(
  db: Database,
  actor: Actor,
  companyId: string,
  sourceId: string,
  kind: "delivery_note" | "invoice_from_proforma" | "replacement_invoice",
  params: { issueDate: string; dueDate?: string },
) {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "documents.create");
    const source = await loadIssued(tx, companyId, sourceId);
    const derive = { newLineId: randomUUID, issueDate: params.issueDate };
    let draft: DocumentDraft;
    if (kind === "delivery_note") draft = buildDeliveryNoteFromInvoice(source, derive);
    else if (kind === "invoice_from_proforma")
      draft = convertProformaToInvoice(source, { ...derive, dueDate: params.dueDate });
    else {
      if (source.type !== "invoice")
        throw new DocumentStateError("source.invalid", "Only invoices can be replaced");
      // Correction workflow: the original stays untouched; it is credited separately and a new,
      // editable invoice references it.
      draft = {
        ...source,
        issueDate: params.issueDate,
        dueDate: params.dueDate,
        lines: source.lines.map((l) => ({ ...l, id: randomUUID(), sourceLineId: undefined })),
        relation: {
          kind: "replaces",
          documentId: source.id,
          documentNumber: source.number,
          issueDate: source.issueDate,
        },
      };
      for (const k of ["id", "number", "status", "issuedAt", "totals", "contentHash"] as const)
        delete (draft as Partial<IssuedDocument>)[k];
    }
    // Derived lines that refer to the source keep sourceLineId only for credit notes; strip others
    // so the same-tenant line FK is only used where it carries meaning.
    if (draft.type !== "credit_note")
      draft = { ...draft, lines: draft.lines.map(({ sourceLineId: _s, ...l }) => l) };
    const id = await insertDraft(tx, actor, companyId, draft, `document.${kind}_draft_created`);
    return toStored(await loadRow(tx, companyId, id));
  });
}

export function hashSnapshot(snapshot: unknown): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

/**
 * Issues a draft: validates, allocates the number, freezes totals and a canonical snapshot with
 * its SHA-256 hash, and records an audit entry — all in one transaction.
 */
export async function issueDocument(
  db: Database,
  actor: Actor,
  companyId: string,
  documentId: string,
  expectedVersion: number,
): Promise<StoredDocument> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "documents.approve");
    const current = await loadRow(tx, companyId, documentId, true);
    if (current.row.status !== "draft")
      throw new DocumentStateError("document.alreadyIssued", "Document is already issued");
    if (current.row.version !== expectedVersion) throw new DocumentVersionConflictError();

    // The issued snapshot freezes the seller as the company profile reads at this moment;
    // later profile edits never touch issued documents (rows and snapshots are immutable).
    const draft: DocumentDraft = {
      ...current.draft,
      seller: applySellerIdentity(current.draft.seller, await loadSellerIdentity(tx, companyId)),
    };
    const issues = validateDocument(draft);
    if (hasBlockingIssues(issues)) throw new DocumentValidationError(issues);

    if (draft.type === "credit_note") {
      const originalId = current.row.relatedDocumentId!;
      // Lock the invoice row so concurrent credit notes for it are issued one at a time.
      await tx
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, originalId), eq(documents.companyId, companyId)))
        .for("update");
      const original = await loadIssued(tx, companyId, originalId);
      if (original.type !== "invoice")
        throw new DocumentStateError(
          "creditNote.original.notInvoice",
          "Credit notes must reference an invoice",
        );
      if (draft.currency !== original.currency)
        throw new DocumentStateError(
          "creditNote.currencyMismatch",
          "Credit note currency must match the invoice",
        );
      if (
        canonicalJson(draft.exchangeRate ?? null) !== canonicalJson(original.exchangeRate ?? null)
      ) {
        throw new DocumentStateError(
          "creditNote.exchangeRateMismatch",
          "Credit note must keep the invoice's exchange-rate snapshot",
        );
      }
      assertCreditWithinRemaining(
        original,
        draft.lines,
        await issuedCreditLines(tx, companyId, originalId, documentId),
      );
    }

    const { seriesId, number } = await allocateDocumentNumber(
      tx,
      companyId,
      draft.type,
      draft.issueDate,
      current.row.seriesId,
    );
    const totals = isPricedDocument(draft.type) ? calculateTotals(draft) : null;
    const issuedAt = new Date();
    const snapshot: IssuedDocument = {
      ...draft,
      id: documentId,
      number,
      status: "issued",
      issuedAt: issuedAt.toISOString(),
      totals,
      contentHash: "",
    };
    const { contentHash: _omit, ...hashed } = snapshot;
    const contentHash = hashSnapshot(hashed);
    snapshot.contentHash = contentHash;

    if (totals) {
      for (const l of totals.lines) {
        await tx
          .update(documentLines)
          .set({ netAmount: l.net })
          .where(and(eq(documentLines.id, l.lineId), eq(documentLines.documentId, documentId)));
      }
    }
    await tx
      .update(documents)
      .set({
        status: "issued",
        seriesId,
        number,
        netTotal: totals?.netTotal ?? null,
        taxTotal: totals?.taxTotal ?? null,
        grossTotal: totals?.grossTotal ?? null,
        taxSummary: totals?.taxSummary ?? null,
        seller: draft.seller,
        snapshot: snapshot as unknown as DocumentDraft & Record<string, unknown>,
        contentHash,
        issuedAt,
        issuedByUserId: actor.userId,
      })
      .where(and(eq(documents.id, documentId), eq(documents.companyId, companyId)));

    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "document.issued",
      entityType: "document",
      entityId: documentId,
      metadata: {
        type: draft.type,
        number,
        contentHash,
        grossTotal: totals?.grossTotal ?? null,
        currency: draft.currency,
        warnings: issues.map((i) => i.code),
      },
    });
    return toStored(await loadRow(tx, companyId, documentId));
  });
}

/** Recomputes the hash of an issued document's snapshot (integrity check). */
export async function verifyDocumentIntegrity(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  documentId: string,
): Promise<boolean> {
  await requireCompanyAccess(db, actor, companyId, "documents.view");
  const { row } = await loadRow(db, companyId, documentId);
  if (row.status !== "issued" || !row.snapshot || !row.contentHash) return false;
  const { contentHash: _omit, ...rest } = row.snapshot as unknown as IssuedDocument;
  return hashSnapshot(rest) === row.contentHash;
}
