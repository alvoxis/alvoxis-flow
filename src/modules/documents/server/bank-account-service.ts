import "server-only";
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { isValidIban, normalizeIban } from "@/lib/iban";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type Database, type DbOrTx } from "@/server/db/client";
import { companyBankAccounts } from "@/server/db/schema";
import { type BankAccountSnapshot } from "../domain/types";
import { type ValidationIssue } from "../domain/validation";
import {
  BankAccountIbanTakenError,
  BankAccountNotFoundError,
  BankAccountVersionConflictError,
  DocumentValidationError,
} from "./errors";

/**
 * Company bank accounts printed on documents. Managed with company.manage (like the rest of the
 * seller's details in the company profile); listed with documents.view (the document editor
 * offers them). The IBAN is the account's identity and never changes; label, bank name, BIC and
 * the default flag can be edited; accounts are archived, never deleted.
 */

type AccountRow = typeof companyBankAccounts.$inferSelect;

export interface BankAccountView {
  id: string;
  label: string | null;
  bankName: string | null;
  iban: string;
  bic: string | null;
  isDefault: boolean;
  archived: boolean;
  version: number;
}

const toView = (r: AccountRow): BankAccountView => ({
  id: r.id,
  label: r.label,
  bankName: r.bankName,
  iban: r.iban,
  bic: r.bic,
  isDefault: r.isDefault,
  archived: r.archivedAt !== null,
  version: r.version,
});

/** What a document prints for an account (frozen in the snapshot when issued). */
export function accountSnapshot(r: AccountRow): BankAccountSnapshot {
  return {
    ...(r.bankName ? { bankName: r.bankName } : {}),
    iban: r.iban,
    ...(r.bic ? { bic: r.bic } : {}),
  };
}

/** BIC/SWIFT: 8 or 11 characters (bank, country, location, optional branch). Format only. */
const BIC = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
const normalizeBic = (v: string) => v.replace(/\s+/g, "").toUpperCase();
const optText = (max: number) => z.string().trim().max(max).optional();

const createSchema = z.strictObject({
  label: optText(100),
  bankName: optText(200),
  iban: z.string().max(64),
  bic: z.string().max(20).optional(),
  isDefault: z.boolean().optional(),
});

const updateSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  label: z.string().trim().max(100).nullable().optional(),
  bankName: z.string().trim().max(200).nullable().optional(),
  bic: z.string().max(20).nullable().optional(),
  isDefault: z.boolean().optional(),
  archived: z.boolean().optional(),
});

function checkBic(bic: string | null | undefined, issues: ValidationIssue[]): string | null {
  if (!bic?.trim()) return null;
  const value = normalizeBic(bic);
  if (!BIC.test(value))
    issues.push({ code: "bankAccount.bic.invalid", severity: "error", path: "bic" });
  return value;
}

/** Lists the company's accounts, default first (documents.view). */
export async function listBankAccounts(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<BankAccountView[]> {
  await requireCompanyAccess(db, actor, companyId, "documents.view");
  const rows = await db
    .select()
    .from(companyBankAccounts)
    .where(
      and(
        eq(companyBankAccounts.companyId, companyId),
        opts.includeArchived ? undefined : isNull(companyBankAccounts.archivedAt),
      ),
    )
    .orderBy(desc(companyBankAccounts.isDefault), asc(companyBankAccounts.createdAt));
  return rows.map(toView);
}

async function clearDefault(tx: DbOrTx, companyId: string, exceptId?: string) {
  await tx
    .update(companyBankAccounts)
    .set({ isDefault: false })
    .where(
      and(
        eq(companyBankAccounts.companyId, companyId),
        eq(companyBankAccounts.isDefault, true),
        exceptId ? ne(companyBankAccounts.id, exceptId) : undefined,
      ),
    );
}

/** Adds an account (company.manage). Invalid IBAN/BIC → 422; active duplicate IBAN → 409. */
export async function createBankAccount(
  db: Database,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<BankAccountView> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "company.manage");
    const data = createSchema.parse(input);
    const issues: ValidationIssue[] = [];
    const iban = normalizeIban(data.iban);
    if (!isValidIban(iban))
      issues.push({ code: "bankAccount.iban.invalid", severity: "error", path: "iban" });
    const bic = checkBic(data.bic, issues);
    if (issues.length) throw new DocumentValidationError(issues);
    if (data.isDefault) await clearDefault(tx, companyId);
    const [row] = await tx
      .insert(companyBankAccounts)
      .values({
        companyId,
        label: data.label || null,
        bankName: data.bankName || null,
        iban,
        bic,
        isDefault: data.isDefault ?? false,
        createdByUserId: actor.userId,
      })
      .onConflictDoNothing({
        target: [companyBankAccounts.companyId, companyBankAccounts.iban],
        where: isNull(companyBankAccounts.archivedAt),
      })
      .returning();
    if (!row) throw new BankAccountIbanTakenError();
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action: "bank_account.created",
      entityType: "bank_account",
      entityId: row.id,
      // Only the masked form is audited; the full IBAN stays in the account row.
      metadata: { iban: `${iban.slice(0, 4)}…${iban.slice(-4)}`, isDefault: row.isDefault },
    });
    return toView(row);
  });
}

/**
 * Edits label/bank name/BIC/default or archives/restores (company.manage, `expectedVersion`).
 * The IBAN cannot change. The row is locked FOR UPDATE, so archiving waits for an issue that
 * holds the account FOR SHARE.
 */
export async function updateBankAccount(
  db: Database,
  actor: Actor,
  companyId: string,
  accountId: string,
  input: unknown,
): Promise<BankAccountView> {
  return db.transaction(async (tx) => {
    await requireCompanyAccess(tx, actor, companyId, "company.manage");
    const data = updateSchema.parse(input);
    const [current] = await tx
      .select()
      .from(companyBankAccounts)
      .where(
        and(eq(companyBankAccounts.id, accountId), eq(companyBankAccounts.companyId, companyId)),
      )
      .for("update");
    if (!current) throw new BankAccountNotFoundError();
    if (current.version !== data.expectedVersion) throw new BankAccountVersionConflictError();
    const issues: ValidationIssue[] = [];
    const bic = data.bic === undefined ? current.bic : checkBic(data.bic, issues);
    if (issues.length) throw new DocumentValidationError(issues);
    const archivedAt =
      data.archived === undefined
        ? current.archivedAt
        : data.archived
          ? (current.archivedAt ?? new Date())
          : null;
    // An archived account is never the default.
    const isDefault = archivedAt ? false : (data.isDefault ?? current.isDefault);
    if (current.archivedAt && !archivedAt) {
      // Restoring: the IBAN must not have become active again under another account.
      const [clash] = await tx
        .select({ id: companyBankAccounts.id })
        .from(companyBankAccounts)
        .where(
          and(
            eq(companyBankAccounts.companyId, companyId),
            eq(companyBankAccounts.iban, current.iban),
            isNull(companyBankAccounts.archivedAt),
          ),
        );
      if (clash) throw new BankAccountIbanTakenError();
    }
    if (isDefault && !current.isDefault) await clearDefault(tx, companyId, accountId);
    const next = {
      label: data.label === undefined ? current.label : data.label || null,
      bankName: data.bankName === undefined ? current.bankName : data.bankName || null,
      bic,
      isDefault,
      archivedAt,
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) =>
      k === "archivedAt"
        ? (next.archivedAt === null) !== (current.archivedAt === null)
        : next[k] !== current[k],
    );
    if (changed.length === 0) return toView(current);
    const [row] = await tx
      .update(companyBankAccounts)
      .set({ ...next, version: current.version + 1 })
      .where(
        and(eq(companyBankAccounts.id, accountId), eq(companyBankAccounts.companyId, companyId)),
      )
      .returning();
    const action = changed.includes("archivedAt")
      ? archivedAt
        ? "bank_account.archived"
        : "bank_account.restored"
      : "bank_account.updated";
    await recordAudit(tx, {
      companyId,
      actorUserId: actor.userId,
      action,
      entityType: "bank_account",
      entityId: accountId,
      metadata: { changed, version: row!.version },
    });
    return toView(row!);
  });
}

/** One account of the company, optionally locked FOR SHARE (issuing, assigning). */
export async function loadBankAccount(
  tx: DbOrTx,
  companyId: string,
  accountId: string,
  lock = false,
): Promise<AccountRow | undefined> {
  const q = tx
    .select()
    .from(companyBankAccounts)
    .where(
      and(eq(companyBankAccounts.id, accountId), eq(companyBankAccounts.companyId, companyId)),
    );
  const [row] = lock ? await q.for("share") : await q;
  return row;
}
