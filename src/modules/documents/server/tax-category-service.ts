import "server-only";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type Database, type DbOrTx } from "@/server/db/client";
import { documentLines, taxCategories } from "@/server/db/schema";
import { taxCategoryCreateSchema, taxCategoryUpdateSchema } from "../domain/schema";
import { type DocumentDraft, type DocumentLine, type TaxCategorySnapshot } from "../domain/types";
import { hasBlockingIssues, validateTaxCategory, type ValidationIssue } from "../domain/validation";
import {
  DocumentValidationError,
  TaxCategoryCodeTakenError,
  TaxCategoryNotFoundError,
  TaxCategoryVersionConflictError,
} from "./errors";
import { normalizeDecimal } from "./mapping";

/**
 * Company tax categories. The catalog only records what the company (or its accountant) defines;
 * it contains no country tax rules and new companies start with an empty catalog. Draft lines
 * reference a category by id and the server builds the line snapshot from it.
 */

type CategoryRow = typeof taxCategories.$inferSelect;

export interface TaxCategoryView {
  id: string;
  code: string;
  kind: CategoryRow["kind"];
  ratePercent: string;
  label: string;
  note: string | null;
  archived: boolean;
  version: number;
}

function toView(row: CategoryRow): TaxCategoryView {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    ratePercent: normalizeDecimal(row.ratePercent),
    label: row.label,
    note: row.note,
    archived: row.archivedAt !== null,
    version: row.version,
  };
}

/** The frozen snapshot a line carries; built only from the company catalog. */
export function categorySnapshot(row: CategoryRow): TaxCategorySnapshot {
  return {
    code: row.code,
    kind: row.kind,
    ratePercent: normalizeDecimal(row.ratePercent),
    label: row.label,
    ...(row.note ? { note: row.note } : {}),
  };
}

/** Lists the company's categories (documents.view: the editor needs them). */
export async function listTaxCategories(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<TaxCategoryView[]> {
  await requireCompanyAccess(db, actor, companyId, "documents.view");
  const rows = await db
    .select()
    .from(taxCategories)
    .where(
      and(
        eq(taxCategories.companyId, companyId),
        opts.includeArchived ? undefined : isNull(taxCategories.archivedAt),
      ),
    )
    .orderBy(asc(taxCategories.code));
  return rows.map(toView);
}

/** Creates a category (tax_categories.manage). Shape errors are ZodErrors; rule errors → 422. */
export async function createTaxCategory(
  db: Database,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<{ taxCategory: TaxCategoryView; issues: ValidationIssue[] }> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "tax_categories.manage");
    const data = taxCategoryCreateSchema.parse(input);
    const issues = validateTaxCategory(data);
    if (hasBlockingIssues(issues)) throw new DocumentValidationError(issues);
    const [row] = await tx
      .insert(taxCategories)
      .values({
        companyId,
        code: data.code,
        kind: data.kind,
        ratePercent: data.ratePercent,
        label: data.label,
        note: data.note || null,
        createdByUserId: actor.userId,
      })
      .onConflictDoNothing({ target: [taxCategories.companyId, taxCategories.code] })
      .returning();
    if (!row) throw new TaxCategoryCodeTakenError();
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "tax_category.created",
      entityType: "tax_category",
      entityId: row.id,
      metadata: { code: row.code, kind: row.kind, ratePercent: normalizeDecimal(row.ratePercent) },
    });
    return { taxCategory: toView(row), issues };
  });
}

/**
 * Edits `label`/`note` or archives/restores a category (tax_categories.manage), with
 * `expectedVersion`. `code`, `kind` and `ratePercent` cannot be changed. The row is locked FOR
 * UPDATE, so archiving waits for any issue that holds the category FOR SHARE (and vice versa).
 */
export async function updateTaxCategory(
  db: Database,
  actor: Actor,
  companyId: string,
  categoryId: string,
  input: unknown,
): Promise<{ taxCategory: TaxCategoryView; issues: ValidationIssue[] }> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "tax_categories.manage");
    const data = taxCategoryUpdateSchema.parse(input);
    const [current] = await tx
      .select()
      .from(taxCategories)
      .where(and(eq(taxCategories.id, categoryId), eq(taxCategories.companyId, companyId)))
      .for("update");
    if (!current) throw new TaxCategoryNotFoundError();
    if (current.version !== data.expectedVersion) throw new TaxCategoryVersionConflictError();

    const label = data.label ?? current.label;
    const note = data.note === undefined ? current.note : data.note || null;
    const archivedAt =
      data.archived === undefined
        ? current.archivedAt
        : data.archived
          ? (current.archivedAt ?? new Date())
          : null;
    const issues = validateTaxCategory({
      kind: current.kind,
      ratePercent: normalizeDecimal(current.ratePercent),
      note: note ?? undefined,
    });
    const changed = [
      ...(label !== current.label ? ["label"] : []),
      ...(note !== current.note ? ["note"] : []),
      ...((archivedAt === null) !== (current.archivedAt === null) ? ["archived"] : []),
    ];
    if (changed.length === 0) return { taxCategory: toView(current), issues };

    const [row] = await tx
      .update(taxCategories)
      .set({ label, note, archivedAt, version: current.version + 1 })
      .where(and(eq(taxCategories.id, categoryId), eq(taxCategories.companyId, companyId)))
      .returning();
    const action = changed.includes("archived")
      ? archivedAt
        ? "tax_category.archived"
        : "tax_category.restored"
      : "tax_category.updated";
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action,
      entityType: "tax_category",
      entityId: categoryId,
      metadata: { code: current.code, changed, version: row!.version },
    });
    return { taxCategory: toView(row!), issues };
  });
}

/** Loads the given categories of one company (optionally locked FOR SHARE). */
export async function loadCategories(
  tx: DbOrTx,
  companyId: string,
  ids: readonly string[],
  lock = false,
): Promise<Map<string, CategoryRow>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const q = tx
    .select()
    .from(taxCategories)
    .where(and(eq(taxCategories.companyId, companyId), inArray(taxCategories.id, unique)))
    .orderBy(asc(taxCategories.id));
  const rows = lock ? await q.for("share") : await q;
  return new Map(rows.map((r) => [r.id, r]));
}

const idsOf = (lines: readonly DocumentLine[]) =>
  lines.flatMap((l) => (l.taxCategoryId ? [l.taxCategoryId] : []));

/**
 * Builds line snapshots from the catalog for the ids a client submitted. Unknown ids (including
 * other companies' categories) and newly assigned archived categories are refused with 422;
 * `keep` lists ids already on the draft, which may stay even if archived since (issuing is then
 * blocked by `taxCategoryFindings`). Categories are locked FOR SHARE until the transaction ends.
 */
export async function assignTaxCategories(
  tx: DbOrTx,
  companyId: string,
  lines: readonly DocumentLine[],
  keep: ReadonlySet<string> = new Set(),
): Promise<DocumentLine[]> {
  const categories = await loadCategories(tx, companyId, idsOf(lines), true);
  const issues: ValidationIssue[] = [];
  const result = lines.map((line, i) => {
    if (!line.taxCategoryId) return { ...line, taxCategory: null };
    const cat = categories.get(line.taxCategoryId);
    const path = `lines.${i}.taxCategoryId`;
    if (!cat) issues.push({ code: "line.taxCategory.unknown", severity: "error", path });
    else if (cat.archivedAt && !keep.has(cat.id))
      issues.push({ code: "line.taxCategory.archived", severity: "error", path });
    return { ...line, taxCategory: cat ? categorySnapshot(cat) : null };
  });
  if (issues.length) throw new DocumentValidationError(issues);
  return result;
}

/**
 * Derived drafts (invoice from proforma, replacement invoice): each line keeps its source line's
 * category when that category is still active, with a fresh snapshot. Otherwise the line keeps
 * the source snapshot without a link, and issuing asks for an explicit choice.
 */
export async function linkDerivedLines(
  tx: DbOrTx,
  companyId: string,
  lines: readonly DocumentLine[],
  sourceLineIds: readonly (string | undefined)[],
): Promise<DocumentLine[]> {
  const sources = sourceLineIds.filter((id): id is string => Boolean(id));
  const rows = sources.length
    ? await tx
        .select({ id: documentLines.id, taxCategoryId: documentLines.taxCategoryId })
        .from(documentLines)
        .where(and(eq(documentLines.companyId, companyId), inArray(documentLines.id, sources)))
    : [];
  const categoryOf = new Map(rows.map((r) => [r.id, r.taxCategoryId]));
  const categories = await loadCategories(
    tx,
    companyId,
    rows.flatMap((r) => (r.taxCategoryId ? [r.taxCategoryId] : [])),
    true,
  );
  return lines.map((line, i) => {
    const { taxCategoryId: _old, ...rest } = line;
    const sourceId = sourceLineIds[i];
    const cat = sourceId ? categories.get(categoryOf.get(sourceId) ?? "") : undefined;
    return cat && !cat.archivedAt
      ? { ...rest, taxCategoryId: cat.id, taxCategory: categorySnapshot(cat) }
      : rest;
  });
}

/**
 * Catalog findings for a draft (blocking): a category archived since it was assigned, or a line
 * whose snapshot predates the catalog (no link) and needs an explicit choice. Credit notes keep
 * the original invoice's snapshots and are not checked against the catalog.
 */
export function taxCategoryFindings(
  draft: DocumentDraft,
  categories: ReadonlyMap<string, Pick<CategoryRow, "archivedAt">>,
): ValidationIssue[] {
  if (draft.type === "credit_note") return [];
  const issues: ValidationIssue[] = [];
  draft.lines.forEach((line, i) => {
    const path = `lines[${i}].taxCategory`;
    if (line.taxCategoryId) {
      const cat = categories.get(line.taxCategoryId);
      if (!cat) issues.push({ code: "line.taxCategory.unknown", severity: "error", path });
      else if (cat.archivedAt)
        issues.push({ code: "line.taxCategory.archived", severity: "error", path });
    } else if (line.taxCategory) {
      issues.push({ code: "line.taxCategory.unlinked", severity: "error", path });
    }
  });
  return issues;
}

/** Ids referenced by the draft's lines (for loading their catalog state). */
export const referencedCategoryIds = idsOf;
