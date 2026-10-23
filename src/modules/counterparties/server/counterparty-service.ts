import "server-only";
import { and, asc, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/server/audit/audit-log";
import {
  type Actor,
  type CompanyContext,
  hasPermission,
  requireCompanyAccess,
} from "@/server/auth/authorization";
import { type Permission } from "@/server/auth/permissions";
import { type Database, type DbOrTx } from "@/server/db/client";
import { counterparties } from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";
import {
  RecordNotFoundError,
  RecordTakenError,
  RecordValidationError,
  RecordVersionConflictError,
} from "@/server/records/errors";
import { type ValidationIssue } from "@/modules/documents/domain/validation";

/**
 * Customers and suppliers. One record can be both; each role is governed by its own permissions
 * (customers.view/manage, suppliers.view/manage), so changing a record that is both needs both
 * manage permissions. The registration number is unique among a company's active records.
 * Records are archived, never deleted: issued documents keep their own copy of the buyer.
 */

export type CounterpartyKind = "customer" | "supplier";

type Row = typeof counterparties.$inferSelect;

export interface CounterpartyView {
  id: string;
  isCustomer: boolean;
  isSupplier: boolean;
  name: string;
  registrationNumber: string | null;
  vatNumber: string | null;
  email: string | null;
  phone: string | null;
  contactName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string | null;
  paymentTermDays: number | null;
  notes: string | null;
  archived: boolean;
  version: number;
}

const toView = (r: Row): CounterpartyView => ({
  id: r.id,
  isCustomer: r.isCustomer,
  isSupplier: r.isSupplier,
  name: r.name,
  registrationNumber: r.registrationNumber,
  vatNumber: r.vatNumber,
  email: r.email,
  phone: r.phone,
  contactName: r.contactName,
  addressLine1: r.addressLine1,
  addressLine2: r.addressLine2,
  postalCode: r.postalCode,
  city: r.city,
  countryCode: r.countryCode,
  paymentTermDays: r.paymentTermDays,
  notes: r.notes,
  archived: r.archivedAt !== null,
  version: r.version,
});

const VIEW: Record<CounterpartyKind, Permission> = {
  customer: "customers.view",
  supplier: "suppliers.view",
};
const MANAGE: Record<CounterpartyKind, Permission> = {
  customer: "customers.manage",
  supplier: "suppliers.manage",
};

const kinds = (r: { isCustomer: boolean; isSupplier: boolean }): CounterpartyKind[] => [
  ...(r.isCustomer ? (["customer"] as const) : []),
  ...(r.isSupplier ? (["supplier"] as const) : []),
];

function requireManage(ctx: CompanyContext, roles: CounterpartyKind[]) {
  const missing = roles.filter((k) => !hasPermission(ctx, MANAGE[k]));
  if (missing.length)
    throw new ForbiddenError(`Missing permission: ${missing.map((k) => MANAGE[k])}`);
}

/** Free text: trimmed, empty → null. */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim() || null)
    .nullable()
    .optional();

const fields = {
  name: z.string().max(200),
  registrationNumber: text(50),
  vatNumber: text(20),
  email: text(254),
  phone: text(50),
  contactName: text(200),
  addressLine1: text(200),
  addressLine2: text(200),
  postalCode: text(20),
  city: text(100),
  countryCode: text(2),
  paymentTermDays: z.number().int().nullable().optional(),
  notes: text(2000),
};

const createSchema = z.strictObject({
  ...fields,
  isCustomer: z.boolean().optional(),
  isSupplier: z.boolean().optional(),
});

const updateSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  ...fields,
  name: fields.name.optional(),
  isCustomer: z.boolean().optional(),
  isSupplier: z.boolean().optional(),
  archived: z.boolean().optional(),
});

type Editable = Omit<
  Row,
  "id" | "companyId" | "version" | "archivedAt" | "createdByUserId" | "createdAt" | "updatedAt"
>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalizes and checks the editable fields; collects every finding at once. */
function validate(v: Editable): Editable {
  const issues: ValidationIssue[] = [];
  const add = (code: string, path: string) => issues.push({ code, severity: "error", path });
  const out: Editable = {
    ...v,
    name: v.name.trim(),
    vatNumber: v.vatNumber ? v.vatNumber.replace(/\s+/g, "").toUpperCase() : null,
    countryCode: v.countryCode ? v.countryCode.toUpperCase() : null,
  };
  if (!out.name) add("counterparty.name.required", "name");
  if (!out.isCustomer && !out.isSupplier) add("counterparty.role.required", "isCustomer");
  if (out.email && !EMAIL.test(out.email)) add("counterparty.email.invalid", "email");
  if (out.countryCode && !/^[A-Z]{2}$/.test(out.countryCode))
    add("counterparty.countryCode.invalid", "countryCode");
  if (out.vatNumber && !/^[A-Z]{2}[A-Z0-9]{2,18}$/.test(out.vatNumber))
    add("counterparty.vatNumber.invalid", "vatNumber");
  if (out.paymentTermDays !== null && (out.paymentTermDays < 0 || out.paymentTermDays > 365))
    add("counterparty.paymentTermDays.range", "paymentTermDays");
  if (issues.length) throw new RecordValidationError(issues);
  return out;
}

/** `true` when another active record of the company has this registration number. */
async function registrationTaken(
  tx: DbOrTx,
  companyId: string,
  registrationNumber: string | null,
  exceptId?: string,
) {
  if (!registrationNumber) return false;
  const rows = await tx
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(
      and(
        eq(counterparties.companyId, companyId),
        eq(counterparties.registrationNumber, registrationNumber),
        isNull(counterparties.archivedAt),
      ),
    );
  return rows.some((r) => r.id !== exceptId);
}

export interface ListCounterpartiesOptions {
  /** Searches name, registration and VAT numbers, email and contact. */
  q?: string;
  includeArchived?: boolean;
}

/** The company's customers or suppliers (customers.view / suppliers.view), by name. */
export async function listCounterparties(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  kind: CounterpartyKind,
  opts: ListCounterpartiesOptions = {},
): Promise<CounterpartyView[]> {
  await requireCompanyAccess(db, actor, companyId, VIEW[kind]);
  const q = opts.q?.trim().slice(0, 100);
  const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : undefined;
  const filters: (SQL | undefined)[] = [
    eq(counterparties.companyId, companyId),
    kind === "customer" ? eq(counterparties.isCustomer, true) : eq(counterparties.isSupplier, true),
    opts.includeArchived ? undefined : isNull(counterparties.archivedAt),
    pattern
      ? or(
          ilike(counterparties.name, pattern),
          ilike(counterparties.registrationNumber, pattern),
          ilike(counterparties.vatNumber, pattern),
          ilike(counterparties.email, pattern),
          ilike(counterparties.contactName, pattern),
        )
      : undefined,
  ];
  const rows = await db
    .select()
    .from(counterparties)
    .where(and(...filters))
    .orderBy(asc(counterparties.archivedAt), asc(counterparties.name), asc(counterparties.id))
    .limit(1000);
  return rows.map(toView);
}

const EMPTY: Omit<Editable, "name" | "isCustomer" | "isSupplier"> = {
  registrationNumber: null,
  vatNumber: null,
  email: null,
  phone: null,
  contactName: null,
  addressLine1: null,
  addressLine2: null,
  postalCode: null,
  city: null,
  countryCode: null,
  paymentTermDays: null,
  notes: null,
};

/**
 * Adds a customer and/or supplier (the manage permission of every chosen role). Invalid fields →
 * 422; an active record with the same registration number → 409 registration_taken.
 */
export async function createCounterparty(
  db: Database,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<CounterpartyView> {
  return db.transaction(async (tx) => {
    const ctx = await requireCompanyAccess(tx, actor, companyId);
    const data = createSchema.parse(input);
    const values = validate({
      ...EMPTY,
      ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
      isCustomer: data.isCustomer ?? false,
      isSupplier: data.isSupplier ?? false,
    } as Editable);
    requireManage(ctx, kinds(values));
    if (await registrationTaken(tx, companyId, values.registrationNumber))
      throw new RecordTakenError("registration_taken");
    const [row] = await tx
      .insert(counterparties)
      .values({ ...values, companyId, createdByUserId: actor.userId })
      .returning();
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "counterparty.created",
      entityType: "counterparty",
      entityId: row!.id,
      metadata: { isCustomer: row!.isCustomer, isSupplier: row!.isSupplier },
    });
    return toView(row!);
  });
}

/** One record (the view permission of one of its roles). Unknown or not visible → 404. */
export async function getCounterparty(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  id: string,
): Promise<CounterpartyView> {
  const ctx = await requireCompanyAccess(db, actor, companyId);
  const [row] = await db
    .select()
    .from(counterparties)
    .where(and(eq(counterparties.id, id), eq(counterparties.companyId, companyId)));
  if (!row || !kinds(row).some((k) => hasPermission(ctx, VIEW[k]))) throw new RecordNotFoundError();
  return toView(row);
}

/**
 * Edits, archives or restores a record (`expectedVersion`; the manage permission of every role
 * it has before and after the change). Stale version → 409; unknown → 404.
 */
export async function updateCounterparty(
  db: Database,
  actor: Actor,
  companyId: string,
  id: string,
  input: unknown,
): Promise<CounterpartyView> {
  return db.transaction(async (tx) => {
    const ctx = await requireCompanyAccess(tx, actor, companyId);
    const data = updateSchema.parse(input);
    const [current] = await tx
      .select()
      .from(counterparties)
      .where(and(eq(counterparties.id, id), eq(counterparties.companyId, companyId)))
      .for("update");
    if (!current || !kinds(current).some((k) => hasPermission(ctx, VIEW[k])))
      throw new RecordNotFoundError();
    if (current.version !== data.expectedVersion) throw new RecordVersionConflictError();
    const { expectedVersion: _v, archived, ...patch } = data;
    const next = validate({
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    } as Editable);
    requireManage(ctx, [...new Set([...kinds(current), ...kinds(next)])]);
    const archivedAt =
      archived === undefined
        ? current.archivedAt
        : archived
          ? (current.archivedAt ?? new Date())
          : null;
    if (
      !archivedAt &&
      (await registrationTaken(tx, companyId, next.registrationNumber, current.id))
    )
      throw new RecordTakenError("registration_taken");
    const keys = Object.keys(EMPTY).concat([
      "name",
      "isCustomer",
      "isSupplier",
    ]) as (keyof Editable)[];
    const changed: string[] = keys.filter((k) => next[k] !== current[k]);
    if ((archivedAt === null) !== (current.archivedAt === null)) changed.push("archived");
    if (changed.length === 0) return toView(current);
    const editable = Object.fromEntries(keys.map((k) => [k, next[k]])) as Editable;
    const [row] = await tx
      .update(counterparties)
      .set({ ...editable, archivedAt, version: current.version + 1 })
      .where(and(eq(counterparties.id, id), eq(counterparties.companyId, companyId)))
      .returning();
    const action = changed.includes("archived")
      ? archivedAt
        ? "counterparty.archived"
        : "counterparty.restored"
      : "counterparty.updated";
    // Field names only: values (names, addresses, emails) stay in the record.
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action,
      entityType: "counterparty",
      entityId: id,
      metadata: { changed, version: row!.version },
    });
    return toView(row!);
  });
}
