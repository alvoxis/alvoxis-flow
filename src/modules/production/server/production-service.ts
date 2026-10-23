import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { type ValidationIssue } from "@/modules/documents/domain/validation";
import { applyStockChanges } from "@/modules/inventory/server/inventory-service";
import { trimDecimal } from "@/modules/products/server/product-service";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type Database, type DbOrTx } from "@/server/db/client";
import {
  productComponents,
  productionOrderComponents,
  productionOrders,
  products,
  warehouses,
} from "@/server/db/schema";
import {
  RecordNotFoundError,
  RecordStateError,
  RecordValidationError,
  RecordVersionConflictError,
} from "@/server/records/errors";

/**
 * Bills of materials and production orders (production.view to read, production.manage to
 * change). An order copies its components from the bill of materials when it is created; later
 * changes to the bill do not change existing orders. Completing an order consumes the components
 * and adds the product in the order's warehouse in one transaction through the stock ledger
 * (which refuses to go below zero); its movements share the order id as `groupId`.
 */

export interface ComponentView {
  componentId: string;
  quantity: string;
}

export interface BillOfMaterialsView {
  productId: string;
  components: ComponentView[];
}

type OrderRow = typeof productionOrders.$inferSelect;
export type OrderStatus = OrderRow["status"];

export interface ProductionOrderView {
  id: string;
  number: string;
  productId: string;
  warehouseId: string;
  quantity: string;
  status: OrderStatus;
  plannedOn: string;
  completedOn: string | null;
  note: string | null;
  version: number;
  /** Totals for the whole order. */
  components: ComponentView[];
}

const QUANTITY = /^\d{1,14}(\.\d{1,4})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date in YYYY-MM-DD form (not 2026-02-30 or 2026-13-01). */
const isValidDate = (s: string) => {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const normalizeQuantity = (v: string) => v.trim().replace(",", ".");
const validQuantity = (v: string) => QUANTITY.test(v) && Number(v) > 0;

// --- bills of materials ---------------------------------------------------------------------

/** Every product's bill of materials (production.view). */
export async function listBillsOfMaterials(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
): Promise<BillOfMaterialsView[]> {
  await requireCompanyAccess(db, actor, companyId, "production.view");
  const rows = await db
    .select()
    .from(productComponents)
    .where(eq(productComponents.companyId, companyId))
    .orderBy(asc(productComponents.productId), asc(productComponents.position));
  const byProduct = new Map<string, ComponentView[]>();
  for (const r of rows)
    byProduct.set(r.productId, [
      ...(byProduct.get(r.productId) ?? []),
      { componentId: r.componentId, quantity: trimDecimal(r.quantity)! },
    ]);
  return [...byProduct.entries()].map(([productId, components]) => ({ productId, components }));
}

const bomSchema = z.strictObject({
  components: z
    .array(z.strictObject({ componentId: z.uuid(), quantity: z.string().max(24) }))
    .max(100),
});

/**
 * Replaces a product's bill of materials (production.manage). An empty list removes it. The
 * product and every component must be the company's goods that track stock; no component twice
 * and never the product itself.
 */
export async function setBillOfMaterials(
  db: Database,
  actor: Actor,
  companyId: string,
  productId: string,
  input: unknown,
): Promise<BillOfMaterialsView> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "production.manage");
    const data = bomSchema.parse(input);
    const ids = [productId, ...data.components.map((c) => c.componentId)];
    const found = await tx
      .select({ id: products.id, trackStock: products.trackStock })
      .from(products)
      .where(and(eq(products.companyId, companyId), inArray(products.id, ids)))
      .for("update");
    const product = found.find((p) => p.id === productId);
    if (!product) throw new RecordNotFoundError();
    const issues: ValidationIssue[] = [];
    const add = (code: string, path: string) => issues.push({ code, severity: "error", path });
    if (!product.trackStock) add("production.product.notTracked", "productId");
    const seen = new Set<string>();
    const components = data.components.map((c, i) => {
      const quantity = normalizeQuantity(c.quantity);
      const p = found.find((x) => x.id === c.componentId);
      if (c.componentId === productId)
        add("production.component.self", `components[${i}].componentId`);
      else if (!p) add("production.component.unknown", `components[${i}].componentId`);
      else if (!p.trackStock)
        add("production.component.notTracked", `components[${i}].componentId`);
      if (seen.has(c.componentId))
        add("production.component.duplicate", `components[${i}].componentId`);
      seen.add(c.componentId);
      if (!validQuantity(quantity)) add("production.quantity.invalid", `components[${i}].quantity`);
      return { componentId: c.componentId, quantity };
    });
    if (issues.length) throw new RecordValidationError(issues);
    await tx
      .delete(productComponents)
      .where(
        and(eq(productComponents.companyId, companyId), eq(productComponents.productId, productId)),
      );
    if (components.length)
      await tx
        .insert(productComponents)
        .values(components.map((c, position) => ({ ...c, position, companyId, productId })));
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "production.bom_set",
      entityType: "product",
      entityId: productId,
      metadata: { components: components.length },
    });
    return {
      productId,
      components: components.map((c) => ({ ...c, quantity: trimDecimal(c.quantity)! })),
    };
  });
}

// --- orders ---------------------------------------------------------------------------------

async function orderComponents(db: DbOrTx, companyId: string, orderIds: string[]) {
  if (!orderIds.length) return new Map<string, ComponentView[]>();
  const rows = await db
    .select()
    .from(productionOrderComponents)
    .where(
      and(
        eq(productionOrderComponents.companyId, companyId),
        inArray(productionOrderComponents.orderId, orderIds),
      ),
    )
    .orderBy(asc(productionOrderComponents.position));
  const map = new Map<string, ComponentView[]>();
  for (const r of rows)
    map.set(r.orderId, [
      ...(map.get(r.orderId) ?? []),
      { componentId: r.componentId, quantity: trimDecimal(r.quantity)! },
    ]);
  return map;
}

const toOrder = (r: OrderRow, components: ComponentView[]): ProductionOrderView => ({
  id: r.id,
  number: r.number,
  productId: r.productId,
  warehouseId: r.warehouseId,
  quantity: trimDecimal(r.quantity)!,
  status: r.status,
  plannedOn: r.plannedOn,
  completedOn: r.completedOn,
  note: r.note,
  version: r.version,
  components,
});

/** Orders, planned first, newest first within a status (production.view). */
export async function listProductionOrders(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  opts: { limit?: number } = {},
): Promise<ProductionOrderView[]> {
  await requireCompanyAccess(db, actor, companyId, "production.view");
  const rows = await db
    .select()
    .from(productionOrders)
    .where(eq(productionOrders.companyId, companyId))
    .orderBy(
      sql`case when ${productionOrders.status} = 'planned' then 0 else 1 end`,
      desc(productionOrders.plannedOn),
      desc(productionOrders.number),
    )
    .limit(Math.min(opts.limit ?? 200, 500));
  const comps = await orderComponents(
    db,
    companyId,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toOrder(r, comps.get(r.id) ?? []));
}

const createSchema = z.strictObject({
  productId: z.uuid(),
  warehouseId: z.uuid(),
  quantity: z.string().max(24),
  plannedOn: z.string().max(10),
  note: z.string().max(1000).nullable().optional(),
});

/** Next PRD-YYYY-NNNN of the company; the caller holds the company's numbering lock. */
async function nextNumber(tx: DbOrTx, companyId: string, year: string) {
  const prefix = `PRD-${year}-`;
  const [row] = await tx
    .select({ last: sql<string | null>`max(${productionOrders.number})` })
    .from(productionOrders)
    .where(
      and(
        eq(productionOrders.companyId, companyId),
        sql`${productionOrders.number} like ${`${prefix}%`}`,
      ),
    );
  const n = row?.last ? Number(row.last.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(4, "0")}`;
}

/**
 * Plans an order (production.manage). The product needs a bill of materials and must track
 * stock; the warehouse must be active. Components are copied with quantities for the whole order
 * (rounded to 4 decimals).
 */
export async function createProductionOrder(
  db: Database,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<ProductionOrderView> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "production.manage");
    const data = createSchema.parse(input);
    const quantity = normalizeQuantity(data.quantity);
    const issues: ValidationIssue[] = [];
    const add = (code: string, path: string) => issues.push({ code, severity: "error", path });
    if (!validQuantity(quantity)) add("production.quantity.invalid", "quantity");
    if (!isValidDate(data.plannedOn)) add("production.date.invalid", "plannedOn");
    const [product] = await tx
      .select({ trackStock: products.trackStock, archivedAt: products.archivedAt })
      .from(products)
      .where(and(eq(products.id, data.productId), eq(products.companyId, companyId)));
    if (!product) add("production.product.unknown", "productId");
    else if (!product.trackStock) add("production.product.notTracked", "productId");
    else if (product.archivedAt) add("production.product.archived", "productId");
    const [store] = await tx
      .select({ archivedAt: warehouses.archivedAt })
      .from(warehouses)
      .where(and(eq(warehouses.id, data.warehouseId), eq(warehouses.companyId, companyId)));
    if (!store) add("stock.warehouse.unknown", "warehouseId");
    else if (store.archivedAt) add("stock.warehouse.archived", "warehouseId");
    const bom = await tx
      .select()
      .from(productComponents)
      .where(
        and(
          eq(productComponents.companyId, companyId),
          eq(productComponents.productId, data.productId),
        ),
      );
    if (product && !bom.length) add("production.bom.missing", "productId");
    if (issues.length) throw new RecordValidationError(issues);
    // Component totals for the whole order, rounded to 4 decimals in PostgreSQL.
    const totals = await tx
      .execute<{ componentId: string; position: number; quantity: string }>(
        sql`select ${productComponents.componentId} as "componentId",
                   ${productComponents.position} as position,
                   round(${productComponents.quantity} * ${quantity}::numeric, 4)::text as quantity
            from ${productComponents}
            where ${productComponents.companyId} = ${companyId}
              and ${productComponents.productId} = ${data.productId}
            order by ${productComponents.position}`,
      )
      .then((r) => r.rows);
    if (totals.some((t) => Number(t.quantity) === 0))
      throw new RecordValidationError([
        { code: "production.quantity.tooSmall", severity: "error", path: "quantity" },
      ]);
    // One numbering lock per company: concurrent orders get consecutive numbers.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`production:${companyId}`}))`);
    const number = await nextNumber(tx, companyId, data.plannedOn.slice(0, 4));
    const [row] = await tx
      .insert(productionOrders)
      .values({
        companyId,
        number,
        productId: data.productId,
        warehouseId: data.warehouseId,
        quantity,
        plannedOn: data.plannedOn,
        note: data.note?.trim() || null,
        createdByUserId: actor.userId,
      })
      .returning();
    await tx
      .insert(productionOrderComponents)
      .values(totals.map((t) => ({ ...t, companyId, orderId: row!.id })));
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "production.order_created",
      entityType: "production_order",
      entityId: row!.id,
      metadata: { number, quantity },
    });
    const comps = await orderComponents(tx, companyId, [row!.id]);
    return toOrder(row!, comps.get(row!.id) ?? []);
  });
}

const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("complete"),
    expectedVersion: z.number().int().positive(),
    completedOn: z.string().max(10),
  }),
  z.strictObject({ action: z.literal("cancel"), expectedVersion: z.number().int().positive() }),
]);

/**
 * Completes or cancels a planned order (production.manage, version). Completing consumes the
 * order's components and adds the product in its warehouse (422 with issues when stock is
 * short); a completed or cancelled order cannot change again (409 invalid_state).
 */
export async function changeProductionOrder(
  db: Database,
  actor: Actor,
  companyId: string,
  orderId: string,
  input: unknown,
): Promise<ProductionOrderView> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "production.manage");
    const data = actionSchema.parse(input);
    const [order] = await tx
      .select()
      .from(productionOrders)
      .where(and(eq(productionOrders.id, orderId), eq(productionOrders.companyId, companyId)))
      .for("update");
    if (!order) throw new RecordNotFoundError();
    if (order.version !== data.expectedVersion) throw new RecordVersionConflictError();
    if (order.status !== "planned") throw new RecordStateError("production.notPlanned");
    const comps = (await orderComponents(tx, companyId, [orderId])).get(orderId) ?? [];
    let completedOn: string | null = null;
    if (data.action === "complete") {
      const issues: ValidationIssue[] = [];
      if (!isValidDate(data.completedOn))
        issues.push({ code: "production.date.invalid", severity: "error", path: "completedOn" });
      else if (data.completedOn > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10))
        issues.push({ code: "stock.date.future", severity: "error", path: "completedOn" });
      if (issues.length) throw new RecordValidationError(issues);
      completedOn = data.completedOn;
      await applyStockChanges(
        tx,
        companyId,
        actor.userId,
        [
          ...comps.map((c) => ({
            productId: c.componentId,
            warehouseId: order.warehouseId,
            kind: "production_consume" as const,
            delta: `-${c.quantity}`,
          })),
          {
            productId: order.productId,
            warehouseId: order.warehouseId,
            kind: "production_output" as const,
            delta: trimDecimal(order.quantity)!,
          },
        ],
        { occurredOn: completedOn, reference: order.number, groupId: order.id },
      );
    }
    const [row] = await tx
      .update(productionOrders)
      .set({
        status: data.action === "complete" ? "completed" : "cancelled",
        completedOn,
        version: order.version + 1,
      })
      .where(and(eq(productionOrders.id, orderId), eq(productionOrders.companyId, companyId)))
      .returning();
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action:
        data.action === "complete" ? "production.order_completed" : "production.order_cancelled",
      entityType: "production_order",
      entityId: orderId,
      metadata: { number: order.number, version: row!.version },
    });
    return toOrder(row!, comps);
  });
}

export interface ProductionCatalog {
  /** Active goods that track stock (products and components). */
  products: { id: string; name: string; sku: string | null; unit: string }[];
  /** Names of every product an order or bill refers to, archived ones included. */
  names: Record<string, string>;
  units: Record<string, string>;
  /** Active warehouses, default first. */
  warehouses: { id: string; code: string; name: string; isDefault: boolean }[];
  /** Balance per `productId:warehouseId`, for availability hints. */
  balances: Record<string, string>;
}

/** What the production page needs to plan orders (production.view). */
export async function productionCatalog(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
): Promise<ProductionCatalog> {
  await requireCompanyAccess(db, actor, companyId, "production.view");
  const [all, stores, sums] = await Promise.all([
    db
      .select()
      .from(products)
      .where(eq(products.companyId, companyId))
      .orderBy(asc(products.name), asc(products.id)),
    db
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.companyId, companyId), sql`${warehouses.archivedAt} is null`))
      .orderBy(desc(warehouses.isDefault), asc(warehouses.code)),
    db.execute<{ productId: string; warehouseId: string; quantity: string }>(sql`
      select product_id as "productId", warehouse_id as "warehouseId", sum(quantity)::text as quantity
      from stock_movements where company_id = ${companyId}
      group by product_id, warehouse_id`),
  ]);
  return {
    products: all
      .filter((p) => p.trackStock && !p.archivedAt)
      .map((p) => ({ id: p.id, name: p.name, sku: p.sku, unit: p.unit })),
    names: Object.fromEntries(all.map((p) => [p.id, p.name])),
    units: Object.fromEntries(all.map((p) => [p.id, p.unit])),
    warehouses: stores.map((w) => ({
      id: w.id,
      code: w.code,
      name: w.name,
      isDefault: w.isDefault,
    })),
    balances: Object.fromEntries(
      sums.rows.map((r) => [`${r.productId}:${r.warehouseId}`, trimDecimal(r.quantity)!]),
    ),
  };
}
