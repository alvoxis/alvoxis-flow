import "server-only";
import { and, asc, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { type ValidationIssue } from "@/modules/documents/domain/validation";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type Database, type DbOrTx } from "@/server/db/client";
import { products, stockMovements, taxCategories } from "@/server/db/schema";
import {
  RecordNotFoundError,
  RecordTakenError,
  RecordValidationError,
  RecordVersionConflictError,
} from "@/server/records/errors";

/**
 * Product and service catalog (products.view to read, products.manage to change). Prices are net
 * decimal strings with up to 4 decimals in the product's currency (EUR or PLN). The SKU is unique
 * among a company's active products. The default tax category must be one of the company's
 * active categories. Archived, never deleted: documents keep their own copy of a line.
 */

type Row = typeof products.$inferSelect;

export type ProductKind = Row["kind"];

export interface ProductView {
  id: string;
  kind: ProductKind;
  sku: string | null;
  name: string;
  description: string | null;
  unit: string;
  barcode: string | null;
  currency: string;
  salePrice: string | null;
  purchasePrice: string | null;
  taxCategoryId: string | null;
  trackStock: boolean;
  archived: boolean;
  version: number;
}

/** "12.5000" → "12.5" (numeric columns come back padded to 4 decimals). */
export function trimDecimal(v: string | null): string | null {
  if (v === null) return null;
  return v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v;
}

const toView = (r: Row): ProductView => ({
  id: r.id,
  kind: r.kind,
  sku: r.sku,
  name: r.name,
  description: r.description,
  unit: r.unit,
  barcode: r.barcode,
  currency: r.currency,
  salePrice: trimDecimal(r.salePrice),
  purchasePrice: trimDecimal(r.purchasePrice),
  taxCategoryId: r.taxCategoryId,
  trackStock: r.trackStock,
  archived: r.archivedAt !== null,
  version: r.version,
});

const text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim() || null)
    .nullable()
    .optional();

const fields = {
  kind: z.enum(["goods", "service"]).optional(),
  sku: text(50),
  name: z.string().max(200),
  description: text(2000),
  unit: z.string().max(20).optional(),
  barcode: text(50),
  currency: z.string().max(3).optional(),
  salePrice: z.string().max(24).nullable().optional(),
  purchasePrice: z.string().max(24).nullable().optional(),
  taxCategoryId: z.uuid().nullable().optional(),
  trackStock: z.boolean().optional(),
};

const createSchema = z.strictObject(fields);
const updateSchema = z.strictObject({
  ...fields,
  name: fields.name.optional(),
  expectedVersion: z.number().int().positive(),
  archived: z.boolean().optional(),
});

type Editable = Pick<
  Row,
  | "kind"
  | "sku"
  | "name"
  | "description"
  | "unit"
  | "barcode"
  | "currency"
  | "salePrice"
  | "purchasePrice"
  | "taxCategoryId"
  | "trackStock"
>;

const EDITABLE: (keyof Editable)[] = [
  "kind",
  "sku",
  "name",
  "description",
  "unit",
  "barcode",
  "currency",
  "salePrice",
  "purchasePrice",
  "taxCategoryId",
  "trackStock",
];

/** Non-negative decimal with up to 4 decimals and 14 integer digits. */
const PRICE = /^\d{1,14}(\.\d{1,4})?$/;

async function validate(tx: DbOrTx, companyId: string, v: Editable): Promise<Editable> {
  const issues: ValidationIssue[] = [];
  const add = (code: string, path: string) => issues.push({ code, severity: "error", path });
  const price = (value: string | null, path: string) => {
    const s = value?.trim().replace(",", ".") ?? "";
    if (!s) return null;
    if (!PRICE.test(s)) {
      add("product.price.invalid", path);
      return null;
    }
    return trimDecimal(s);
  };
  const out: Editable = {
    ...v,
    name: v.name.trim(),
    unit: v.unit.trim(),
    sku: v.sku ? v.sku.trim().toUpperCase() : null,
    currency: v.currency.trim().toUpperCase(),
    salePrice: price(v.salePrice, "salePrice"),
    purchasePrice: price(v.purchasePrice, "purchasePrice"),
    // Services have no stock.
    trackStock: v.kind === "goods" && v.trackStock,
  };
  if (!out.name) add("product.name.required", "name");
  if (!out.unit) add("product.unit.required", "unit");
  if (!["EUR", "PLN"].includes(out.currency)) add("product.currency.invalid", "currency");
  if (out.taxCategoryId) {
    const [cat] = await tx
      .select({ archivedAt: taxCategories.archivedAt })
      .from(taxCategories)
      .where(and(eq(taxCategories.id, out.taxCategoryId), eq(taxCategories.companyId, companyId)));
    if (!cat) add("product.taxCategory.unknown", "taxCategoryId");
    else if (cat.archivedAt) add("product.taxCategory.archived", "taxCategoryId");
  }
  if (issues.length) throw new RecordValidationError(issues);
  return out;
}

async function skuTaken(tx: DbOrTx, companyId: string, sku: string | null, exceptId?: string) {
  if (!sku) return false;
  const rows = await tx
    .select({ id: products.id })
    .from(products)
    .where(
      and(eq(products.companyId, companyId), eq(products.sku, sku), isNull(products.archivedAt)),
    );
  return rows.some((r) => r.id !== exceptId);
}

/** The company's products by name (products.view); `q` searches name, SKU and barcode. */
export async function listProducts(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  opts: { q?: string; includeArchived?: boolean } = {},
): Promise<ProductView[]> {
  await requireCompanyAccess(db, actor, companyId, "products.view");
  const q = opts.q?.trim().slice(0, 100);
  const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : undefined;
  const filters: (SQL | undefined)[] = [
    eq(products.companyId, companyId),
    opts.includeArchived ? undefined : isNull(products.archivedAt),
    pattern
      ? or(
          ilike(products.name, pattern),
          ilike(products.sku, pattern),
          ilike(products.barcode, pattern),
        )
      : undefined,
  ];
  const rows = await db
    .select()
    .from(products)
    .where(and(...filters))
    .orderBy(asc(products.archivedAt), asc(products.name), asc(products.id))
    .limit(2000);
  return rows.map(toView);
}

/** One product of the company (products.view); unknown → 404. */
export async function getProduct(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  id: string,
): Promise<ProductView> {
  await requireCompanyAccess(db, actor, companyId, "products.view");
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, id), eq(products.companyId, companyId)));
  if (!row) throw new RecordNotFoundError();
  return toView(row);
}

const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Adds a product (products.manage). Invalid → 422; active SKU taken → 409 sku_taken. */
export async function createProduct(
  db: Database,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<ProductView> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "products.manage");
    const data = createSchema.parse(input);
    const values = await validate(tx, companyId, {
      kind: "goods",
      sku: null,
      description: null,
      unit: "pcs",
      barcode: null,
      currency: "EUR",
      salePrice: null,
      purchasePrice: null,
      taxCategoryId: null,
      trackStock: false,
      ...(defined(data) as Partial<Editable>),
      name: data.name,
    });
    if (await skuTaken(tx, companyId, values.sku)) throw new RecordTakenError("sku_taken");
    const [row] = await tx
      .insert(products)
      .values({ ...values, companyId, createdByUserId: actor.userId })
      .returning();
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "product.created",
      entityType: "product",
      entityId: row!.id,
      metadata: { kind: row!.kind, trackStock: row!.trackStock },
    });
    return toView(row!);
  });
}

/**
 * Edits, archives or restores a product (products.manage, `expectedVersion`). Stale version →
 * 409; unknown → 404; a restored product whose SKU is used again → 409 sku_taken.
 */
export async function updateProduct(
  db: Database,
  actor: Actor,
  companyId: string,
  id: string,
  input: unknown,
): Promise<ProductView> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "products.manage");
    const data = updateSchema.parse(input);
    const [current] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, id), eq(products.companyId, companyId)))
      .for("update");
    if (!current) throw new RecordNotFoundError();
    if (current.version !== data.expectedVersion) throw new RecordVersionConflictError();
    const { expectedVersion: _v, archived, ...patch } = data;
    const merged = { ...current, ...(defined(patch) as Partial<Editable>) };
    // An unchanged archived category does not block other edits.
    const next = await validate(
      tx,
      companyId,
      merged.taxCategoryId === current.taxCategoryId ? { ...merged, taxCategoryId: null } : merged,
    );
    if (merged.taxCategoryId === current.taxCategoryId) next.taxCategoryId = current.taxCategoryId;
    // A product with stock history keeps tracking stock (its ledger would lose its meaning).
    if (current.trackStock && !next.trackStock) {
      const [moved] = await tx
        .select({ id: stockMovements.id })
        .from(stockMovements)
        .where(and(eq(stockMovements.companyId, companyId), eq(stockMovements.productId, id)))
        .limit(1);
      if (moved)
        throw new RecordValidationError([
          { code: "product.trackStock.inUse", severity: "error", path: "trackStock" },
        ]);
    }
    const archivedAt =
      archived === undefined
        ? current.archivedAt
        : archived
          ? (current.archivedAt ?? new Date())
          : null;
    if (!archivedAt && (await skuTaken(tx, companyId, next.sku, id)))
      throw new RecordTakenError("sku_taken");
    const comparable = (k: keyof Editable, r: Editable) =>
      k === "salePrice" || k === "purchasePrice" ? trimDecimal(r[k]) : r[k];
    const changed: string[] = EDITABLE.filter(
      (k) => comparable(k, next) !== comparable(k, current),
    );
    if ((archivedAt === null) !== (current.archivedAt === null)) changed.push("archived");
    if (changed.length === 0) return toView(current);
    const [row] = await tx
      .update(products)
      .set({
        ...Object.fromEntries(EDITABLE.map((k) => [k, next[k]])),
        archivedAt,
        version: current.version + 1,
      })
      .where(and(eq(products.id, id), eq(products.companyId, companyId)))
      .returning();
    const action = changed.includes("archived")
      ? archivedAt
        ? "product.archived"
        : "product.restored"
      : "product.updated";
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action,
      entityType: "product",
      entityId: id,
      metadata: { changed, version: row!.version },
    });
    return toView(row!);
  });
}
