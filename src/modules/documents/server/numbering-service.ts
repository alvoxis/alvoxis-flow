import { and, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type DbOrTx } from "@/server/db/client";
import { documentNumberCounters, documentNumberSeries } from "@/server/db/schema";
import {
  formatDocumentNumber,
  numberingPeriodKey,
  type NumberingResetPolicy,
  validateNumberingPattern,
} from "../domain/numbering";
import { type DocumentType } from "../domain/types";
import { DocumentStateError } from "./errors";

/** Suggested defaults. Companies can change them; existing numbers are never renumbered. */
export const DEFAULT_SERIES: Record<
  DocumentType,
  { name: string; pattern: string; resetPolicy: NumberingResetPolicy }
> = {
  invoice: { name: "Invoices", pattern: "INV-{yyyy}-{seq:4}", resetPolicy: "yearly" },
  proforma: { name: "Proforma invoices", pattern: "PF-{yyyy}-{seq:4}", resetPolicy: "yearly" },
  credit_note: { name: "Credit notes", pattern: "CN-{yyyy}-{seq:4}", resetPolicy: "yearly" },
  delivery_note: { name: "Delivery notes", pattern: "DN-{yyyy}-{seq:4}", resetPolicy: "yearly" },
};

export interface CreateSeriesInput {
  documentType: DocumentType;
  name: string;
  pattern: string;
  resetPolicy: NumberingResetPolicy;
  isDefault?: boolean;
}

export async function createNumberSeries(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  input: CreateSeriesInput,
) {
  await requireCompanyAccess(db, actor, companyId, "company.manage");
  const errors = validateNumberingPattern(input);
  if (errors.length) throw new DocumentStateError("numbering.pattern.invalid", errors.join("; "));
  const [row] = await db
    .insert(documentNumberSeries)
    .values({ companyId, ...input, isDefault: input.isDefault ?? false })
    .returning();
  await recordAudit(db, {
    companyId,
    actorUserId: actor.userId,
    action: "document_series.created",
    entityType: "document_number_series",
    entityId: row!.id,
    metadata: {
      documentType: input.documentType,
      pattern: input.pattern,
      resetPolicy: input.resetPolicy,
    },
  });
  return row!;
}

/** Creates the default series for any document type that has none (idempotent). */
export async function ensureDefaultNumberSeries(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
): Promise<void> {
  await requireCompanyAccess(db, actor, companyId, "company.manage");
  for (const [documentType, def] of Object.entries(DEFAULT_SERIES) as [
    DocumentType,
    (typeof DEFAULT_SERIES)[DocumentType],
  ][]) {
    await db
      .insert(documentNumberSeries)
      .values({ companyId, documentType, ...def, isDefault: true })
      .onConflictDoNothing();
  }
}

/**
 * Allocates the next number in a series. MUST run inside the issuing transaction: the counter
 * row stays locked until commit (serialising concurrent issues), and a rollback releases the
 * number, so failed issues leave no gaps.
 */
export async function allocateDocumentNumber(
  tx: DbOrTx,
  companyId: string,
  documentType: DocumentType,
  issueDate: string,
  seriesId: string | null,
): Promise<{ seriesId: string; number: string }> {
  const [series] = await tx
    .select()
    .from(documentNumberSeries)
    .where(
      and(
        eq(documentNumberSeries.companyId, companyId),
        eq(documentNumberSeries.documentType, documentType),
        isNull(documentNumberSeries.archivedAt),
        seriesId ? eq(documentNumberSeries.id, seriesId) : eq(documentNumberSeries.isDefault, true),
      ),
    )
    .limit(1);
  if (!series)
    throw new DocumentStateError(
      "numbering.series.missing",
      `No active numbering series for ${documentType}`,
    );

  const periodKey = numberingPeriodKey(series, issueDate);
  const [counter] = await tx
    .insert(documentNumberCounters)
    .values({ seriesId: series.id, companyId, periodKey, lastValue: 1 })
    .onConflictDoUpdate({
      target: [documentNumberCounters.seriesId, documentNumberCounters.periodKey],
      set: { lastValue: sql`${documentNumberCounters.lastValue} + 1` },
    })
    .returning({ lastValue: documentNumberCounters.lastValue });

  return {
    seriesId: series.id,
    number: formatDocumentNumber(series.pattern, counter!.lastValue, issueDate),
  };
}
