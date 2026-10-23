import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { type ValidationIssue } from "@/modules/documents/domain/validation";
import { trimDecimal } from "@/modules/products/server/product-service";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type Database, type DbOrTx } from "@/server/db/client";
import { products, stockMovements, warehouses } from "@/server/db/schema";
import {
  RecordNotFoundError,
  RecordStateError,
  RecordTakenError,
  RecordValidationError,
  RecordVersionConflictError,
} from "@/server/records/errors";

/**
 * Warehouses and the stock ledger (inventory.view to read, inventory.manage to change). A balance
 * is the sum of a product's movements in a warehouse; movements are append-only. Every operation
 * that may lower a balance locks the products it touches (in id order, so concurrent operations
 * cannot deadlock) and refuses to go below zero. Quantities are decimal strings with up to 4
 * decimals; all arithmetic happens in PostgreSQL `numeric`.
 */

type WarehouseRow = typeof warehouses.$inferSelect;
type MovementRow = typeof stockMovements.$inferSelect;
export type MovementKind = MovementRow["kind"];

export interface WarehouseView {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
  archived: boolean;
  version: number;
}

const toWarehouse = (r: WarehouseRow): WarehouseView => ({
  id: r.id,
  code: r.code,
  name: r.name,
  isDefault: r.isDefault,
  archived: r.archivedAt !== null,
  version: r.version,
});

export interface MovementView {
  id: string;
  productId: string;
  warehouseId: string;
  kind: MovementKind;
  quantity: string;
  unitCost: string | null;
  occurredOn: string;
  reference: string | null;
  note: string | null;
  groupId: string | null;
  createdAt: string;
}

const toMovement = (r: MovementRow): MovementView => ({
  id: r.id,
  productId: r.productId,
  warehouseId: r.warehouseId,
  kind: r.kind,
  quantity: trimDecimal(r.quantity)!,
  unitCost: trimDecimal(r.unitCost),
  occurredOn: r.occurredOn,
  reference: r.reference,
  note: r.note,
  groupId: r.groupId,
  createdAt: r.createdAt.toISOString(),
});

export interface StockLevelView {
  productId: string;
  name: string;
  sku: string | null;
  unit: string;
  currency: string;
  purchasePrice: string | null;
  trackStock: boolean;
  archived: boolean;
  /** Sum over all warehouses. */
  total: string;
  /** Quantity per warehouse id (only warehouses with movements). */
  byWarehouse: Record<string, string>;
}

/** Positive decimal, up to 14 integer digits and 4 decimals. */
const QUANTITY = /^\d{1,14}(\.\d{1,4})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isValidDate = (s: string) =>
  DATE.test(s) &&
  !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

// --- warehouses -----------------------------------------------------------------------------

const warehouseCreate = z.strictObject({
  code: z.string().max(20),
  name: z.string().max(100),
  isDefault: z.boolean().optional(),
});
const warehouseUpdate = z.strictObject({
  expectedVersion: z.number().int().positive(),
  name: z.string().max(100).optional(),
  isDefault: z.boolean().optional(),
  archived: z.boolean().optional(),
});

/** Warehouses of the company, default first (inventory.view). */
export async function listWarehouses(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<WarehouseView[]> {
  await requireCompanyAccess(db, actor, companyId, "inventory.view");
  const rows = await db
    .select()
    .from(warehouses)
    .where(
      and(
        eq(warehouses.companyId, companyId),
        opts.includeArchived ? undefined : isNull(warehouses.archivedAt),
      ),
    )
    .orderBy(desc(warehouses.isDefault), asc(warehouses.archivedAt), asc(warehouses.code));
  return rows.map(toWarehouse);
}

async function clearDefault(tx: DbOrTx, companyId: string) {
  await tx
    .update(warehouses)
    .set({ isDefault: false })
    .where(and(eq(warehouses.companyId, companyId), eq(warehouses.isDefault, true)));
}

/** Adds a warehouse (inventory.manage). The first one becomes the default. Code taken → 409. */
export async function createWarehouse(
  db: Database,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<WarehouseView> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "inventory.manage");
    const data = warehouseCreate.parse(input);
    const code = data.code.trim().toUpperCase();
    const name = data.name.trim();
    const issues: ValidationIssue[] = [];
    if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(code))
      issues.push({ code: "warehouse.code.invalid", severity: "error", path: "code" });
    if (!name) issues.push({ code: "warehouse.name.required", severity: "error", path: "name" });
    if (issues.length) throw new RecordValidationError(issues);
    const existing = await tx
      .select({ id: warehouses.id, code: warehouses.code, archivedAt: warehouses.archivedAt })
      .from(warehouses)
      .where(eq(warehouses.companyId, companyId));
    if (existing.some((w) => w.code === code)) throw new RecordTakenError("code_taken");
    const isDefault = data.isDefault || !existing.some((w) => w.archivedAt === null);
    if (isDefault) await clearDefault(tx, companyId);
    const [row] = await tx
      .insert(warehouses)
      .values({ companyId, code, name, isDefault })
      .returning();
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "warehouse.created",
      entityType: "warehouse",
      entityId: row!.id,
      metadata: { code, isDefault },
    });
    return toWarehouse(row!);
  });
}

/** Non-zero balances in a warehouse (any product). */
async function warehouseHasStock(tx: DbOrTx, companyId: string, warehouseId: string) {
  const rows = await tx
    .select({ productId: stockMovements.productId })
    .from(stockMovements)
    .where(
      and(eq(stockMovements.companyId, companyId), eq(stockMovements.warehouseId, warehouseId)),
    )
    .groupBy(stockMovements.productId)
    .having(sql`sum(${stockMovements.quantity}) <> 0`)
    .limit(1);
  return rows.length > 0;
}

/**
 * Renames, makes default, archives or restores a warehouse (inventory.manage, version). A
 * warehouse holding stock cannot be archived (409 invalid_state warehouse.notEmpty); an archived
 * one is never the default.
 */
export async function updateWarehouse(
  db: Database,
  actor: Actor,
  companyId: string,
  id: string,
  input: unknown,
): Promise<WarehouseView> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "inventory.manage");
    const data = warehouseUpdate.parse(input);
    const [current] = await tx
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.id, id), eq(warehouses.companyId, companyId)))
      .for("update");
    if (!current) throw new RecordNotFoundError();
    if (current.version !== data.expectedVersion) throw new RecordVersionConflictError();
    const name = data.name === undefined ? current.name : data.name.trim();
    if (!name)
      throw new RecordValidationError([
        { code: "warehouse.name.required", severity: "error", path: "name" },
      ]);
    const archivedAt =
      data.archived === undefined
        ? current.archivedAt
        : data.archived
          ? (current.archivedAt ?? new Date())
          : null;
    if (archivedAt && !current.archivedAt) {
      // Lock the ledger rows' products would be overkill; a receipt racing an archive is
      // refused by recordStockOperation (archived warehouse), which re-reads under FOR SHARE.
      if (await warehouseHasStock(tx, companyId, id))
        throw new RecordStateError("warehouse.notEmpty");
    }
    const isDefault = archivedAt ? false : (data.isDefault ?? current.isDefault);
    if (isDefault && !current.isDefault) await clearDefault(tx, companyId);
    const changed = [
      name !== current.name ? "name" : "",
      isDefault !== current.isDefault ? "isDefault" : "",
      (archivedAt === null) !== (current.archivedAt === null) ? "archived" : "",
    ].filter(Boolean);
    if (!changed.length) return toWarehouse(current);
    const [row] = await tx
      .update(warehouses)
      .set({ name, isDefault, archivedAt, version: current.version + 1 })
      .where(and(eq(warehouses.id, id), eq(warehouses.companyId, companyId)))
      .returning();
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: changed.includes("archived")
        ? archivedAt
          ? "warehouse.archived"
          : "warehouse.restored"
        : "warehouse.updated",
      entityType: "warehouse",
      entityId: id,
      metadata: { changed, version: row!.version },
    });
    return toWarehouse(row!);
  });
}

// --- stock ----------------------------------------------------------------------------------

/**
 * Stock per product and warehouse (inventory.view): every product that tracks stock or has
 * movements, by name. Archived products appear while they still hold stock.
 */
export async function stockLevels(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
): Promise<StockLevelView[]> {
  await requireCompanyAccess(db, actor, companyId, "inventory.view");
  const sums = await db
    .select({
      productId: stockMovements.productId,
      warehouseId: stockMovements.warehouseId,
      quantity: sql<string>`sum(${stockMovements.quantity})::text`,
    })
    .from(stockMovements)
    .where(eq(stockMovements.companyId, companyId))
    .groupBy(stockMovements.productId, stockMovements.warehouseId);
  const totals = await db
    .select({
      productId: stockMovements.productId,
      quantity: sql<string>`sum(${stockMovements.quantity})::text`,
    })
    .from(stockMovements)
    .where(eq(stockMovements.companyId, companyId))
    .groupBy(stockMovements.productId);
  const total = new Map(totals.map((t) => [t.productId, trimDecimal(t.quantity)!]));
  const rows = await db
    .select()
    .from(products)
    .where(eq(products.companyId, companyId))
    .orderBy(asc(products.name), asc(products.id));
  return rows
    .filter((p) =>
      total.has(p.id) ? !(p.archivedAt && total.get(p.id) === "0") : p.trackStock && !p.archivedAt,
    )
    .map((p) => ({
      productId: p.id,
      name: p.name,
      sku: p.sku,
      unit: p.unit,
      currency: p.currency,
      purchasePrice: trimDecimal(p.purchasePrice),
      trackStock: p.trackStock,
      archived: p.archivedAt !== null,
      total: total.get(p.id) ?? "0",
      byWarehouse: Object.fromEntries(
        sums
          .filter((s) => s.productId === p.id && trimDecimal(s.quantity) !== "0")
          .map((s) => [s.warehouseId, trimDecimal(s.quantity)!]),
      ),
    }));
}

/** Latest movements, newest first (inventory.view), optionally of one product or warehouse. */
export async function listMovements(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  opts: { productId?: string; warehouseId?: string; limit?: number } = {},
): Promise<MovementView[]> {
  await requireCompanyAccess(db, actor, companyId, "inventory.view");
  const rows = await db
    .select()
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.companyId, companyId),
        opts.productId ? eq(stockMovements.productId, opts.productId) : undefined,
        opts.warehouseId ? eq(stockMovements.warehouseId, opts.warehouseId) : undefined,
      ),
    )
    .orderBy(desc(stockMovements.createdAt), desc(stockMovements.id))
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  return rows.map(toMovement);
}

/** One change of stock to apply: `delta` is a signed decimal string. */
export interface StockChange {
  productId: string;
  warehouseId: string;
  kind: MovementKind;
  delta: string;
  unitCost?: string | null;
}

/**
 * Applies movements in the caller's transaction: locks the products (id order), checks that each
 * product tracks stock, each warehouse is active, and that no balance goes below zero; then
 * writes the ledger rows. Findings are reported together (422). Used by stock operations and by
 * production orders.
 */
export async function applyStockChanges(
  tx: DbOrTx,
  companyId: string,
  actorUserId: string,
  changes: StockChange[],
  meta: { occurredOn: string; reference?: string | null; note?: string | null; groupId?: string },
): Promise<MovementView[]> {
  const productIds = [...new Set(changes.map((c) => c.productId))].sort();
  const warehouseIds = [...new Set(changes.map((c) => c.warehouseId))];
  const locked = await tx
    .select({
      id: products.id,
      trackStock: products.trackStock,
    })
    .from(products)
    .where(and(eq(products.companyId, companyId), inArray(products.id, productIds)))
    .orderBy(asc(products.id))
    .for("update");
  const stores = await tx
    .select({ id: warehouses.id, archivedAt: warehouses.archivedAt })
    .from(warehouses)
    .where(and(eq(warehouses.companyId, companyId), inArray(warehouses.id, warehouseIds)))
    .for("share");
  const issues: ValidationIssue[] = [];
  const add = (code: string, path: string) => issues.push({ code, severity: "error", path });
  for (const c of changes) {
    const p = locked.find((x) => x.id === c.productId);
    if (!p) add("stock.product.unknown", "productId");
    else if (!p.trackStock) add("stock.product.notTracked", "productId");
    const w = stores.find((x) => x.id === c.warehouseId);
    if (!w) add("stock.warehouse.unknown", "warehouseId");
    else if (w.archivedAt) add("stock.warehouse.archived", "warehouseId");
  }
  if (issues.length) throw new RecordValidationError(dedupe(issues));
  // Net change per product and warehouse; only decreases can break the zero floor.
  const net = new Map<string, { productId: string; warehouseId: string; deltas: string[] }>();
  for (const c of changes) {
    const key = `${c.productId}:${c.warehouseId}`;
    const entry = net.get(key) ?? {
      productId: c.productId,
      warehouseId: c.warehouseId,
      deltas: [],
    };
    entry.deltas.push(c.delta);
    net.set(key, entry);
  }
  for (const { productId, warehouseId, deltas } of net.values()) {
    const sum = sql.join(
      deltas.map((d) => sql`${d}::numeric`),
      sql` + `,
    );
    const [row] = await tx
      .execute<{ ok: boolean }>(
        sql`
      select coalesce(sum(${stockMovements.quantity}), 0) + (${sum}) >= 0 as ok
      from ${stockMovements}
      where ${stockMovements.companyId} = ${companyId}
        and ${stockMovements.productId} = ${productId}
        and ${stockMovements.warehouseId} = ${warehouseId}`,
      )
      .then((r) => r.rows);
    if (!row?.ok) add("stock.quantity.insufficient", "quantity");
  }
  if (issues.length) throw new RecordValidationError(dedupe(issues));
  const rows = await tx
    .insert(stockMovements)
    .values(
      changes.map((c) => ({
        companyId,
        productId: c.productId,
        warehouseId: c.warehouseId,
        kind: c.kind,
        quantity: c.delta,
        unitCost: c.unitCost ?? null,
        occurredOn: meta.occurredOn,
        reference: meta.reference ?? null,
        note: meta.note ?? null,
        groupId: meta.groupId ?? null,
        createdByUserId: actorUserId,
      })),
    )
    .returning();
  return rows.map(toMovement);
}

const dedupe = (issues: ValidationIssue[]) => [
  ...new Map(issues.map((i) => [`${i.code}:${i.path}`, i])).values(),
];

const operationSchema = z.strictObject({
  kind: z.enum(["receipt", "issue", "transfer", "count"]),
  productId: z.uuid(),
  warehouseId: z.uuid(),
  toWarehouseId: z.uuid().optional(),
  /** receipt/issue/transfer: the moved quantity (> 0); count: the counted quantity (≥ 0). */
  quantity: z.string().max(24),
  unitCost: z.string().max(24).nullable().optional(),
  occurredOn: z.string().max(10),
  reference: z.string().max(100).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
});

/**
 * Records a receipt, an issue (write-off/sale), a transfer between warehouses or a stock count
 * (inventory.manage). A count writes the difference to the current balance as an adjustment
 * (nothing when equal). Invalid input or a balance that would go below zero → 422 with issues.
 */
export async function recordStockOperation(
  db: Database,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<MovementView[]> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "inventory.manage");
    const data = operationSchema.parse(input);
    const issues: ValidationIssue[] = [];
    const add = (code: string, path: string) => issues.push({ code, severity: "error", path });
    const quantity = data.quantity.trim().replace(",", ".");
    const counting = data.kind === "count";
    if (!QUANTITY.test(quantity) || (!counting && Number(quantity) === 0))
      add("stock.quantity.invalid", "quantity");
    const unitCost = data.unitCost?.trim().replace(",", ".") || null;
    if (unitCost !== null && (data.kind !== "receipt" || !QUANTITY.test(unitCost)))
      add("stock.unitCost.invalid", "unitCost");
    if (!isValidDate(data.occurredOn)) add("stock.date.invalid", "occurredOn");
    else if (data.occurredOn > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10))
      add("stock.date.future", "occurredOn");
    if (data.kind === "transfer") {
      if (!data.toWarehouseId) add("stock.transfer.target", "toWarehouseId");
      else if (data.toWarehouseId === data.warehouseId)
        add("stock.transfer.sameWarehouse", "toWarehouseId");
    }
    if (issues.length) throw new RecordValidationError(issues);
    const q = trimDecimal(quantity)!;
    const meta = {
      occurredOn: data.occurredOn,
      reference: data.reference?.trim() || null,
      note: data.note?.trim() || null,
    };
    let changes: StockChange[];
    if (data.kind === "receipt")
      changes = [
        { ...data, kind: "receipt", delta: q, unitCost: unitCost && trimDecimal(unitCost) },
      ];
    else if (data.kind === "issue") changes = [{ ...data, kind: "issue", delta: `-${q}` }];
    else if (data.kind === "transfer")
      changes = [
        {
          productId: data.productId,
          warehouseId: data.warehouseId,
          kind: "transfer_out",
          delta: `-${q}`,
        },
        {
          productId: data.productId,
          warehouseId: data.toWarehouseId!,
          kind: "transfer_in",
          delta: q,
        },
      ];
    else {
      // The difference is computed under the product lock taken by applyStockChanges' first
      // query; take it here first so the count and the write see the same balance.
      const [product] = await tx
        .select({ trackStock: products.trackStock })
        .from(products)
        .where(and(eq(products.id, data.productId), eq(products.companyId, companyId)))
        .for("update");
      if (!product?.trackStock)
        throw new RecordValidationError([
          {
            code: product ? "stock.product.notTracked" : "stock.product.unknown",
            severity: "error",
            path: "productId",
          },
        ]);
      const [diff] = await tx
        .execute<{ delta: string }>(
          sql`
          select (${q}::numeric - coalesce(sum(${stockMovements.quantity}), 0))::text as delta
          from ${stockMovements}
          where ${stockMovements.companyId} = ${companyId}
            and ${stockMovements.productId} = ${data.productId}
            and ${stockMovements.warehouseId} = ${data.warehouseId}`,
        )
        .then((r) => r.rows);
      const delta = trimDecimal(diff!.delta)!;
      if (delta === "0") return [];
      changes = [
        { productId: data.productId, warehouseId: data.warehouseId, kind: "adjustment", delta },
      ];
    }
    const groupId = data.kind === "transfer" ? randomUUID() : undefined;
    const written = await applyStockChanges(tx, companyId, actor.userId, changes, {
      ...meta,
      groupId,
    });
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: `stock.${data.kind}`,
      entityType: "product",
      entityId: data.productId,
      metadata: {
        movements: written.map((m) => ({
          id: m.id,
          warehouseId: m.warehouseId,
          quantity: m.quantity,
        })),
      },
    });
    return written;
  });
}

/** Names of the given products (inventory.view), e.g. archived ones shown in the movement list. */
export async function productNames(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  ids: readonly string[],
): Promise<Record<string, string>> {
  await requireCompanyAccess(db, actor, companyId, "inventory.view");
  if (!ids.length) return {};
  const rows = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(and(eq(products.companyId, companyId), inArray(products.id, [...new Set(ids)])));
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}
