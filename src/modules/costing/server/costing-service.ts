import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type Database, type DbOrTx } from "@/server/db/client";
import { costCalculations, products } from "@/server/db/schema";
import {
  RecordNotFoundError,
  RecordValidationError,
  RecordVersionConflictError,
} from "@/server/records/errors";
import {
  calculateCost,
  calculationInputSchema,
  type CalculationResult,
  type ParsedCalculation,
} from "../domain/calculate";

/**
 * Saved cost calculations (products.view to read and export, products.manage to save, change and
 * delete). The server recomputes the result from the validated input on every save; a client
 * cannot store figures of its own. Audit entries name the calculation id only.
 */

export interface CostCalculationView {
  id: string;
  name: string;
  productId: string | null;
  productName: string | null;
  currency: "EUR" | "PLN";
  input: ParsedCalculation;
  result: CalculationResult;
  version: number;
  updatedAt: string;
}

const bodySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  productId: z.uuid().nullable().optional(),
  calculation: z.unknown(),
});
const updateSchema = bodySchema.extend({ expectedVersion: z.number().int().positive() });

const KNOWN_ISSUES = new Set(["decimal", "too_large", "positive", "percent_range"]);

/** Validation problems of the calculation as record issues (paths under `calculation.`). */
function parseCalculation(raw: unknown): ParsedCalculation {
  const parsed = calculationInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new RecordValidationError(
      parsed.error.issues.map((i) => ({
        code: `costing.${KNOWN_ISSUES.has(i.message) ? i.message : "invalid"}`,
        severity: "error" as const,
        path: ["calculation", ...i.path].join("."),
      })),
    );
  return parsed.data;
}

async function checkProduct(tx: DbOrTx, companyId: string, productId: string | null | undefined) {
  if (!productId) return;
  const [p] = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.companyId, companyId)));
  if (!p)
    throw new RecordValidationError([
      { code: "costing.product.unknown", severity: "error", path: "productId" },
    ]);
}

async function load(db: DbOrTx, companyId: string, id?: string) {
  const rows = await db
    .select({ row: costCalculations, productName: products.name })
    .from(costCalculations)
    .leftJoin(products, eq(products.id, costCalculations.productId))
    .where(
      and(eq(costCalculations.companyId, companyId), id ? eq(costCalculations.id, id) : undefined),
    )
    .orderBy(desc(costCalculations.updatedAt))
    .limit(500);
  return rows.map((r): CostCalculationView => ({
    id: r.row.id,
    name: r.row.name,
    productId: r.row.productId,
    productName: r.productName,
    currency: r.row.currency,
    input: r.row.input,
    result: r.row.result,
    version: r.row.version,
    updatedAt: r.row.updatedAt.toISOString(),
  }));
}

export async function listCalculations(db: DbOrTx, actor: Actor, companyId: string) {
  await requireCompanyAccess(db, actor, companyId, "products.view");
  return load(db, companyId);
}

export async function getCalculation(db: DbOrTx, actor: Actor, companyId: string, id: string) {
  await requireCompanyAccess(db, actor, companyId, "products.view");
  const [one] = await load(db, companyId, id);
  if (!one) throw new RecordNotFoundError();
  return one;
}

/** Saves a new calculation (products.manage) → its view with the server's result. */
export async function createCalculation(
  db: Database,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<CostCalculationView> {
  const id = await db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "products.manage");
    const body = bodySchema.parse(input);
    const calculation = parseCalculation(body.calculation);
    await checkProduct(tx, companyId, body.productId);
    const [row] = await tx
      .insert(costCalculations)
      .values({
        companyId,
        name: body.name,
        productId: body.productId ?? null,
        currency: calculation.currency,
        input: calculation,
        result: calculateCost(calculation),
        createdByUserId: actor.userId,
      })
      .returning({ id: costCalculations.id });
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "costing.saved",
      entityType: "cost_calculation",
      entityId: row!.id,
    });
    return row!.id;
  });
  return (await load(db, companyId, id))[0]!;
}

/** Replaces a calculation (products.manage, `expectedVersion`). Stale → 409. */
export async function updateCalculation(
  db: Database,
  actor: Actor,
  companyId: string,
  id: string,
  input: unknown,
): Promise<CostCalculationView> {
  await db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "products.manage");
    const body = updateSchema.parse(input);
    const [current] = await tx
      .select({ version: costCalculations.version })
      .from(costCalculations)
      .where(and(eq(costCalculations.id, id), eq(costCalculations.companyId, companyId)))
      .for("update");
    if (!current) throw new RecordNotFoundError();
    if (current.version !== body.expectedVersion) throw new RecordVersionConflictError();
    const calculation = parseCalculation(body.calculation);
    await checkProduct(tx, companyId, body.productId);
    await tx
      .update(costCalculations)
      .set({
        name: body.name,
        productId: body.productId ?? null,
        currency: calculation.currency,
        input: calculation,
        result: calculateCost(calculation),
        version: current.version + 1,
      })
      .where(and(eq(costCalculations.id, id), eq(costCalculations.companyId, companyId)));
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "costing.saved",
      entityType: "cost_calculation",
      entityId: id,
      metadata: { version: current.version + 1 },
    });
  });
  return (await load(db, companyId, id))[0]!;
}

export async function deleteCalculation(db: Database, actor: Actor, companyId: string, id: string) {
  await db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "products.manage");
    const gone = await tx
      .delete(costCalculations)
      .where(and(eq(costCalculations.id, id), eq(costCalculations.companyId, companyId)))
      .returning({ id: costCalculations.id });
    if (gone.length === 0) throw new RecordNotFoundError();
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "costing.deleted",
      entityType: "cost_calculation",
      entityId: id,
    });
  });
}
