import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
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
  type DocumentLine,
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
import { accountSnapshot, loadBankAccount } from "./bank-account-service";
import { allocateDocumentNumber } from "./numbering-service";
import {
  assignTaxCategories,
  categorySnapshot,
  linkDerivedLines,
  loadCategories,
  referencedCategoryIds,
  taxCategoryFindings,
} from "./tax-category-service";
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
  const draft = rowToDraft(row, lines, related);
  // Catalog state of the referenced categories (drafts only: issued documents use the snapshot).
  const categories =
    row.status === "draft"
      ? await loadCategories(db, companyId, referencedCategoryIds(draft.lines))
      : new Map();
  const bankAccount =
    row.status === "draft" && row.bankAccountId
      ? await loadBankAccount(db, companyId, row.bankAccountId)
      : undefined;
  return { row, lines, draft, categories, bankAccount };
}

/** Blocking finding: the draft's bank account was archived after it was chosen. */
function bankAccountFindings(
  draft: DocumentDraft,
  account: { archivedAt: Date | null } | undefined,
): ValidationIssue[] {
  if (!draft.bankAccountId) return [];
  return !account || account.archivedAt
    ? [{ code: "bankAccount.archived", severity: "error", path: "bankAccountId" }]
    : [];
}

/** `bankAccountId` as submitted: undefined (keep), null (none) or an id (input already parsed). */
function bankChoice(input: unknown): string | null | undefined {
  const v = (input as { bankAccountId?: unknown }).bankAccountId;
  return typeof v === "string" || v === null ? v : undefined;
}

/**
 * Resolves the submitted bank account choice against the company's accounts and builds the
 * printed details from the account row (never from the request). Unknown or other companies'
 * accounts → 422 `bankAccount.unknown`; a newly chosen archived account → 422
 * `bankAccount.archived` (the draft's current account may stay, issuing is then blocked).
 */
async function assignBankAccount(
  tx: DbOrTx,
  companyId: string,
  choice: string | null | undefined,
  current?: Pick<DocumentDraft, "bankAccounts" | "bankAccountId">,
): Promise<Pick<DocumentDraft, "bankAccounts" | "bankAccountId">> {
  if (choice === undefined)
    return current
      ? { bankAccounts: current.bankAccounts, bankAccountId: current.bankAccountId }
      : { bankAccounts: [], bankAccountId: undefined };
  if (choice === null) return { bankAccounts: [], bankAccountId: undefined };
  const account = await loadBankAccount(tx, companyId, choice, true);
  const path = "bankAccountId";
  if (!account)
    throw new DocumentValidationError([{ code: "bankAccount.unknown", severity: "error", path }]);
  if (account.archivedAt && current?.bankAccountId !== account.id)
    throw new DocumentValidationError([{ code: "bankAccount.archived", severity: "error", path }]);
  return { bankAccounts: [accountSnapshot(account)], bankAccountId: account.id };
}

function toStored(loaded: Awaited<ReturnType<typeof loadRow>>): StoredDocument {
  const { row, draft, categories, bankAccount } = loaded;
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
    issues:
      row.status === "draft"
        ? [
            ...validateDocument(draft),
            ...taxCategoryFindings(draft, categories),
            ...bankAccountFindings(draft, bankAccount),
          ]
        : [],
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

/** Line ids as submitted (parseDraftInput assigns fresh ids; the input already passed its shape). */
function submittedLineIds(input: unknown): (string | undefined)[] {
  const lines = (input as { lines?: unknown }).lines;
  return Array.isArray(lines)
    ? lines.map((l) =>
        typeof (l as { id?: unknown })?.id === "string" ? (l as { id: string }).id : undefined,
      )
    : [];
}

/**
 * Lines saved before the company catalog existed carry a snapshot without a catalog link. When a
 * save resubmits such a line unchanged in its category (same line id of THIS draft, no category
 * chosen), the stored snapshot is kept — taken from the database, never from the request — so a
 * save cannot silently lose the previous tax data. The line stays unlinked and issuing remains
 * blocked until a category is chosen explicitly; choosing one replaces the snapshot.
 */
function keepLegacySnapshots(
  lines: DocumentLine[],
  submittedIds: readonly (string | undefined)[],
  currentLines: readonly DocumentLine[],
): DocumentLine[] {
  const legacy = new Map(
    currentLines.flatMap((l) => (!l.taxCategoryId && l.taxCategory ? [[l.id, l.taxCategory]] : [])),
  );
  return lines.map((line, i) => {
    const snapshot = legacy.get(submittedIds[i] ?? "");
    return !line.taxCategoryId && snapshot ? { ...line, taxCategory: snapshot } : line;
  });
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
    const lines = await assignTaxCategories(tx, companyId, draft.lines);
    const bank = await assignBankAccount(tx, companyId, bankChoice(input));
    const id = await insertDraft(
      tx,
      actor,
      companyId,
      { ...draft, ...bank, lines },
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
    let lines: DocumentLine[];
    if (current.row.type === "credit_note") {
      // Credit-note lines keep pointing at the original invoice lines and always carry the
      // invoice line's tax snapshot; any category in the request is ignored.
      const original = await loadIssued(tx, companyId, current.row.relatedDocumentId!);
      const originalLines = new Map(original.lines.map((l) => [l.id, l]));
      lines = next.lines.map(({ taxCategoryId: _ignored, ...l }, i) => {
        const sourceLineId = current.draft.lines[i]?.sourceLineId;
        const source = sourceLineId ? originalLines.get(sourceLineId) : undefined;
        return { ...l, sourceLineId, taxCategory: source?.taxCategory ?? null };
      });
    } else {
      // Categories already on the draft may stay even if archived since; new ones must be active.
      const keep = new Set(referencedCategoryIds(current.draft.lines));
      lines = keepLegacySnapshots(
        await assignTaxCategories(tx, companyId, next.lines, keep),
        submittedLineIds(input),
        current.draft.lines,
      );
    }

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
    } = draftToRowValues({
      ...next,
      ...(await assignBankAccount(tx, companyId, bankChoice(input), current.draft)),
    });
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
      // The buyer as stored on the row; issued rows are immutable and match their snapshot.
      buyerName: sql<string | null>`${documents.buyer}->>'name'`,
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
    // Priced derived lines keep their source line's catalog category while it is active.
    if (kind !== "delivery_note") {
      const sourceIds =
        kind === "replacement_invoice"
          ? source.lines.map((l) => l.id)
          : draft.lines.map((l) => l.sourceLineId);
      draft = { ...draft, lines: await linkDerivedLines(tx, companyId, draft.lines, sourceIds) };
    }
    // Derived invoices keep the source's bank account while it is active (fresh details);
    // otherwise they keep the source's printed details without a link.
    if (kind !== "delivery_note") {
      const [src] = await tx
        .select({ bankAccountId: documents.bankAccountId })
        .from(documents)
        .where(and(eq(documents.id, sourceId), eq(documents.companyId, companyId)));
      const account = src?.bankAccountId
        ? await loadBankAccount(tx, companyId, src.bankAccountId, true)
        : undefined;
      if (account && !account.archivedAt)
        draft = { ...draft, bankAccounts: [accountSnapshot(account)], bankAccountId: account.id };
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
    // Catalog categories are locked FOR SHARE so they cannot be archived while this issue runs;
    // their current label/note go into the snapshot (code, kind and rate never change).
    const categories = await loadCategories(
      tx,
      companyId,
      referencedCategoryIds(current.draft.lines),
      true,
    );
    const lines = current.draft.lines.map((l) => {
      const cat =
        current.row.type !== "credit_note" && l.taxCategoryId
          ? categories.get(l.taxCategoryId)
          : undefined;
      return cat ? { ...l, taxCategory: categorySnapshot(cat) } : l;
    });
    // The chosen bank account is locked FOR SHARE (archiving takes FOR UPDATE); its current
    // details go into the snapshot.
    const bankAccount = current.draft.bankAccountId
      ? await loadBankAccount(tx, companyId, current.draft.bankAccountId, true)
      : undefined;
    const draft: DocumentDraft = {
      ...current.draft,
      seller: applySellerIdentity(current.draft.seller, await loadSellerIdentity(tx, companyId)),
      lines,
      ...(bankAccount && !bankAccount.archivedAt
        ? { bankAccounts: [accountSnapshot(bankAccount)] }
        : {}),
    };
    const issues = [
      ...validateDocument(draft),
      ...taxCategoryFindings(draft, categories),
      ...bankAccountFindings(draft, bankAccount),
    ];
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
      // Defence in depth: every credited line must carry its invoice line's tax snapshot.
      const originalLines = new Map(original.lines.map((l) => [l.id, l]));
      if (
        draft.lines.some(
          (l) =>
            canonicalJson(l.taxCategory) !==
            canonicalJson(originalLines.get(l.sourceLineId ?? "")?.taxCategory ?? null),
        )
      ) {
        throw new DocumentStateError(
          "creditNote.taxCategoryMismatch",
          "Credit note lines must keep the invoice's tax categories",
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
      // Catalog links are a draft-time reference, never part of the issued content.
      lines: draft.lines.map(({ taxCategoryId: _id, ...l }) => l),
      bankAccountId: undefined,
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

    // Line rows mirror the snapshot's (possibly relabelled) categories before the rows freeze.
    for (const l of draft.lines) {
      if (!l.taxCategoryId) continue;
      await tx
        .update(documentLines)
        .set({ taxCategory: l.taxCategory })
        .where(and(eq(documentLines.id, l.id), eq(documentLines.documentId, documentId)));
    }
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
        bankAccounts: draft.bankAccounts,
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
