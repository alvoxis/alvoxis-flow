import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCreditNoteDraft,
  createDraft,
  deriveDraft,
  issueDocument,
  updateDraft,
  verifyDocumentIntegrity,
} from "@/modules/documents/server/document-service";
import { updateBankAccount } from "@/modules/documents/server/bank-account-service";
import { DocumentValidationError } from "@/modules/documents/server/errors";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import {
  auditLogs,
  companies,
  companyBankAccounts,
  documents,
  memberships,
  roles,
  users,
} from "@/server/db/schema";
import { UnauthenticatedError } from "@/server/errors";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";
import {
  addFixtureBankAccount,
  FIXTURE_BANK_ACCOUNT,
  FIXTURE_BANK_ACCOUNT_2,
} from "../support/bank-account-fixtures";
import { FIXTURE_SELLER_PROFILE, invoiceDraft } from "../support/document-fixtures";
import { addFixtureTaxCategories, withCategoryIds } from "../support/tax-category-fixtures";
import { openTestDb } from "./test-db";

/**
 * Company bank accounts: the HTTP layer (real route handlers, services and database; only the
 * session lookup is stubbed), choosing an account on documents, freezing its details on issue,
 * and issued documents staying unchanged when the account is edited or archived later.
 * Synthetic IBANs (valid checksums, fictitious banks) only.
 */
const session = vi.hoisted(() => ({
  db: undefined as unknown,
  actor: null as { userId: string; twoFactorVerified: boolean } | null,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/server/auth/instance", () => ({ getAuth: () => ({}) }));
vi.mock("@/server/db/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDb: () => session.db,
}));
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireUser: async () => {
    if (!session.actor) throw new UnauthenticatedError();
    return { ...session.actor, sessionId: "test-session" };
  },
}));

const collection = await import("@/app/api/companies/[companyId]/bank-accounts/route");
const single = await import("@/app/api/companies/[companyId]/bank-accounts/[accountId]/route");
const docs = await import("@/app/api/companies/[companyId]/documents/route");
const doc = await import("@/app/api/companies/[companyId]/documents/[documentId]/route");
const issueRoute =
  await import("@/app/api/companies/[companyId]/documents/[documentId]/issue/route");

let db: Database;
let pool: Pool;
beforeAll(() => {
  ({ db, pool } = openTestDb());
  session.db = db;
});
afterAll(async () => pool.end());
beforeEach(() => {
  session.actor = null;
});

const actorOf = (userId: string): Actor => ({ userId, twoFactorVerified: true });
const as = (actor: Actor | null) => {
  session.actor = actor;
};

async function newUser() {
  const [u] = await db
    .insert(users)
    .values({ email: `bank-${randomUUID()}@example.test` })
    .returning();
  return u!;
}

async function newCompany() {
  const owner = actorOf((await newUser()).id);
  const { companyId } = await createCompanyWithOwner(db, owner, { name: "Bank Co", country: "LV" });
  await db.update(companies).set(FIXTURE_SELLER_PROFILE).where(eq(companies.id, companyId));
  await ensureDefaultNumberSeries(db, owner, companyId);
  const cats = await addFixtureTaxCategories(db, owner, companyId);
  return { owner, companyId, cats };
}

async function member(companyId: string, roleKey: string) {
  const u = await newUser();
  const [role] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.companyId, companyId), eq(roles.key, roleKey)));
  await db.insert(memberships).values({ companyId, userId: u.id, roleId: role!.id });
  return actorOf(u.id);
}

/** Draft API input without inline bank details (the account is chosen by id). */
function input(cats: Record<string, string>, extra: Record<string, unknown> = {}) {
  const { lines, relation: _r, bankAccounts: _b, ...rest } = invoiceDraft();
  return {
    ...rest,
    lines: withCategoryIds(
      lines.map(({ id: _i, sourceLineId: _s, ...l }) => l),
      cats,
    ),
    ...extra,
  };
}

const req = (method: string, body?: unknown, url = "http://localhost/api") =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const p = <T extends object>(v: T) => ({ params: Promise.resolve(v) });

async function call(res: Response | Promise<Response>) {
  const r = await res;
  // Response bodies are asserted field by field; a loose type keeps the assertions readable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

const api = {
  list: (companyId: string, includeArchived = false) =>
    call(
      collection.GET(
        req("GET", undefined, `http://localhost/api${includeArchived ? "?includeArchived=1" : ""}`),
        p({ companyId }),
      ),
    ),
  create: (companyId: string, body: unknown) =>
    call(collection.POST(req("POST", body), p({ companyId }))),
  patch: (companyId: string, accountId: string, body: unknown) =>
    call(single.PATCH(req("PATCH", body), p({ companyId, accountId }))),
  createDoc: (companyId: string, body: unknown) =>
    call(docs.POST(req("POST", body), p({ companyId }))),
  patchDoc: (companyId: string, documentId: string, body: unknown) =>
    call(doc.PATCH(req("PATCH", body), p({ companyId, documentId }))),
  getDoc: (companyId: string, documentId: string) =>
    call(doc.GET(req("GET"), p({ companyId, documentId }))),
  issue: (companyId: string, documentId: string, expectedVersion: number) =>
    call(issueRoute.POST(req("POST", { expectedVersion }), p({ companyId, documentId }))),
};

const codes = (body: { issues?: unknown }) =>
  (body.issues as { code: string }[]).map((i) => i.code);

describe("bank accounts API", () => {
  it("adds accounts with a normalized IBAN and BIC; validates both; one active account per IBAN", async () => {
    const { owner, companyId } = await newCompany();
    as(owner);
    const created = await api.create(companyId, {
      iban: " lv80 bank 0000 4351 9500 1 ",
      bic: "examlv2x",
      bankName: "Example Bank AS",
      label: "Main",
      isDefault: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.bankAccount).toMatchObject({
      iban: FIXTURE_BANK_ACCOUNT.iban,
      bic: FIXTURE_BANK_ACCOUNT.bic,
      bankName: "Example Bank AS",
      label: "Main",
      isDefault: true,
      archived: false,
      version: 1,
    });

    const badIban = await api.create(companyId, { iban: "LV80BANK0000435195002" });
    expect(badIban).toMatchObject({ status: 422, body: { error: "validation_failed" } });
    expect(codes(badIban.body)).toEqual(["bankAccount.iban.invalid"]);
    for (const bic of ["EXAM", "EXAMLV2", "EXAMLV2XX", "1XAMLV2X"]) {
      const badBic = await api.create(companyId, { iban: FIXTURE_BANK_ACCOUNT_2.iban, bic });
      expect(codes(badBic.body)).toEqual(["bankAccount.bic.invalid"]);
    }
    // An 11-character BIC (with branch code) is accepted.
    expect(
      (await api.create(companyId, { iban: FIXTURE_BANK_ACCOUNT_2.iban, bic: "SAMPLT2XABC" })).body
        .bankAccount.bic,
    ).toBe("SAMPLT2XABC");

    const duplicate = await api.create(companyId, { iban: FIXTURE_BANK_ACCOUNT.iban });
    expect(duplicate).toMatchObject({ status: 409, body: { error: "iban_taken" } });
    expect((await api.create(companyId, { iban: "LV80BANK", extra: 1 })).status).toBe(422);
    expect((await api.list(companyId)).body.bankAccounts).toHaveLength(2);

    // The audit log never contains the full IBAN.
    const audit = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, created.body.bankAccount.id));
    expect(audit.map((a) => a.action)).toEqual(["bank_account.created"]);
    expect(JSON.stringify(audit)).not.toContain(FIXTURE_BANK_ACCOUNT.iban);
  });

  it("edits details but never the IBAN; one default; archive and restore with version checks", async () => {
    const { owner, companyId } = await newCompany();
    as(owner);
    const a = (await api.create(companyId, { ...FIXTURE_BANK_ACCOUNT, isDefault: true })).body
      .bankAccount;
    const b = (await api.create(companyId, FIXTURE_BANK_ACCOUNT_2)).body.bankAccount;

    const ibanChange = await api.patch(companyId, a.id, {
      expectedVersion: 1,
      iban: FIXTURE_BANK_ACCOUNT_2.iban,
    });
    expect(ibanChange.status).toBe(422);
    const edited = await api.patch(companyId, a.id, {
      expectedVersion: 1,
      label: "Renamed",
      bankName: null,
      bic: "exaMLV2X",
    });
    expect(edited.body.bankAccount).toMatchObject({
      label: "Renamed",
      bankName: null,
      bic: "EXAMLV2X",
      iban: FIXTURE_BANK_ACCOUNT.iban,
      version: 2,
    });
    expect((await api.patch(companyId, a.id, { expectedVersion: 1, label: "X" })).status).toBe(409);

    // Making b the default clears a; the list shows the default first.
    await api.patch(companyId, b.id, { expectedVersion: 1, isDefault: true });
    const listed = (await api.list(companyId)).body.bankAccounts;
    expect(listed.map((x: { id: string; isDefault: boolean }) => [x.id, x.isDefault])).toEqual([
      [b.id, true],
      [a.id, false],
    ]);

    // Archiving drops the default flag and hides the account from the picker list.
    const archived = await api.patch(companyId, b.id, { expectedVersion: 2, archived: true });
    expect(archived.body.bankAccount).toMatchObject({ archived: true, isDefault: false });
    expect((await api.list(companyId)).body.bankAccounts.map((x: { id: string }) => x.id)).toEqual([
      a.id,
    ]);
    expect((await api.list(companyId, true)).body.bankAccounts).toHaveLength(2);

    // The IBAN is free again once archived; restoring the old account then clashes.
    const again = await api.create(companyId, FIXTURE_BANK_ACCOUNT_2);
    expect(again.status).toBe(201);
    expect(await api.patch(companyId, b.id, { expectedVersion: 3, archived: false })).toMatchObject(
      { status: 409, body: { error: "iban_taken" } },
    );
    await api.patch(companyId, again.body.bankAccount.id, { expectedVersion: 1, archived: true });
    expect(
      (await api.patch(companyId, b.id, { expectedVersion: 3, archived: false })).body.bankAccount,
    ).toMatchObject({ archived: false, isDefault: false, version: 4 });

    const actions = (
      await db
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(eq(auditLogs.entityId, b.id))
        .orderBy(asc(auditLogs.createdAt))
    ).map((r) => r.action);
    expect(actions).toEqual([
      "bank_account.created",
      "bank_account.updated",
      "bank_account.archived",
      "bank_account.restored",
    ]);
  });

  it("database constraints: one default and one active IBAN per company, valid formats only", async () => {
    const { owner, companyId } = await newCompany();
    await addFixtureBankAccount(db, owner, companyId);
    const insert = (values: Partial<typeof companyBankAccounts.$inferInsert>) =>
      db.insert(companyBankAccounts).values({
        companyId,
        iban: FIXTURE_BANK_ACCOUNT_2.iban,
        ...values,
      });
    await expect(insert({ isDefault: true })).rejects.toThrow();
    await expect(insert({ iban: FIXTURE_BANK_ACCOUNT.iban })).rejects.toThrow();
    await expect(insert({ iban: "lv80bank0000435195001" })).rejects.toThrow();
    await expect(insert({ bic: "BAD" })).rejects.toThrow();
  });

  it("read with documents.view, manage with company.manage; other companies' accounts are not found", async () => {
    const { owner, companyId } = await newCompany();
    const id = await addFixtureBankAccount(db, owner, companyId);
    for (const role of ["accountant", "manager", "warehouse_employee"]) {
      as(await member(companyId, role));
      expect((await api.list(companyId)).status).toBe(200);
      expect((await api.create(companyId, FIXTURE_BANK_ACCOUNT_2)).status).toBe(403);
      expect((await api.patch(companyId, id, { expectedVersion: 1, label: "X" })).status).toBe(403);
    }
    as(await member(companyId, "production_employee")); // no documents.view
    expect((await api.list(companyId)).status).toBe(403);
    as(await member(companyId, "administrator"));
    expect((await api.patch(companyId, id, { expectedVersion: 1, label: "Admin" })).status).toBe(
      200,
    );
    as(actorOf((await newUser()).id));
    expect((await api.list(companyId)).status).toBe(403);
    as(null);
    expect((await api.list(companyId)).status).toBe(401);

    const other = await newCompany();
    as(other.owner);
    expect((await api.patch(other.companyId, id, { expectedVersion: 2, label: "X" })).status).toBe(
      404,
    );
    expect((await api.list(other.companyId)).body.bankAccounts).toEqual([]);
    expect((await api.list(companyId)).status).toBe(403);
  });
});

describe("bank accounts on documents", () => {
  it("copies the chosen account; keeps, switches or clears it on save; refuses inline details and foreign ids", async () => {
    const { owner, companyId, cats } = await newCompany();
    const a = await addFixtureBankAccount(db, owner, companyId);
    const b = await addFixtureBankAccount(db, owner, companyId, FIXTURE_BANK_ACCOUNT_2);
    as(owner);

    const inline = await api.createDoc(companyId, {
      ...input(cats),
      bankAccounts: [{ iban: FIXTURE_BANK_ACCOUNT.iban }],
    });
    expect(inline.status).toBe(422);
    const foreign = await newCompany();
    const foreignId = await addFixtureBankAccount(db, foreign.owner, foreign.companyId);
    for (const id of [foreignId, randomUUID()]) {
      const res = await api.createDoc(companyId, input(cats, { bankAccountId: id }));
      expect(res.status).toBe(422);
      expect(codes(res.body)).toEqual(["bankAccount.unknown"]);
    }

    const created = await api.createDoc(companyId, input(cats, { bankAccountId: a }));
    expect(created.status).toBe(201);
    const d = created.body.document;
    expect(d.draft).toMatchObject({ bankAccountId: a, bankAccounts: [FIXTURE_BANK_ACCOUNT] });
    expect(d.issues).toEqual([]);

    // Saving without bankAccountId keeps the account; an id switches it; null clears it.
    const kept = await api.patchDoc(companyId, d.id, {
      expectedVersion: 1,
      draft: input(cats, { notes: "Edited" }),
    });
    expect(kept.body.document.draft).toMatchObject({
      bankAccountId: a,
      bankAccounts: [FIXTURE_BANK_ACCOUNT],
    });
    const switched = await api.patchDoc(companyId, d.id, {
      expectedVersion: 2,
      draft: input(cats, { bankAccountId: b }),
    });
    expect(switched.body.document.draft).toMatchObject({
      bankAccountId: b,
      bankAccounts: [FIXTURE_BANK_ACCOUNT_2],
    });
    const cleared = await api.patchDoc(companyId, d.id, {
      expectedVersion: 3,
      draft: input(cats, { bankAccountId: null }),
    });
    expect(cleared.body.document.draft.bankAccountId).toBeUndefined();
    expect(cleared.body.document.draft.bankAccounts).toEqual([]);
    expect(codes(cleared.body.document)).toEqual(["bankAccount.missing"]); // a warning only
  });

  it("issuing freezes the account's current details; later edits and archiving leave the issued document unchanged", async () => {
    const { owner, companyId, cats } = await newCompany();
    const a = await addFixtureBankAccount(db, owner, companyId);
    as(owner);
    const d = (await api.createDoc(companyId, input(cats, { bankAccountId: a }))).body.document;
    // Edited after the draft was saved: the issue takes the details as they are now.
    await updateBankAccount(db, owner, companyId, a, { expectedVersion: 1, bankName: "Renamed" });

    const issued = await api.issue(companyId, d.id, 1);
    expect(issued.status).toBe(200);
    const frozen = { ...FIXTURE_BANK_ACCOUNT, bankName: "Renamed" };
    expect(issued.body.document.draft.bankAccounts).toEqual([frozen]);
    expect(issued.body.document.draft).not.toHaveProperty("bankAccountId");
    const [before] = await db.select().from(documents).where(eq(documents.id, d.id));
    expect(before!.snapshot).toMatchObject({ bankAccounts: [frozen] });

    await updateBankAccount(db, owner, companyId, a, {
      expectedVersion: 2,
      bankName: "Changed later",
      bic: null,
    });
    await updateBankAccount(db, owner, companyId, a, { expectedVersion: 3, archived: true });

    const [after] = await db.select().from(documents).where(eq(documents.id, d.id));
    expect(after).toEqual(before);
    expect(await verifyDocumentIntegrity(db, owner, companyId, d.id)).toBe(true);
    expect((await api.getDoc(companyId, d.id)).body.document.draft.bankAccounts).toEqual([frozen]);
    // The issued row cannot be pointed at other details either.
    await expect(
      db.update(documents).set({ bankAccounts: [] }).where(eq(documents.id, d.id)),
    ).rejects.toThrow();
  });

  it("an archived account blocks issuing without using a number; choosing another one unblocks it", async () => {
    const { owner, companyId, cats } = await newCompany();
    const a = await addFixtureBankAccount(db, owner, companyId);
    const b = await addFixtureBankAccount(db, owner, companyId, FIXTURE_BANK_ACCOUNT_2);
    as(owner);
    const d = (await api.createDoc(companyId, input(cats, { bankAccountId: a }))).body.document;
    await updateBankAccount(db, owner, companyId, a, { expectedVersion: 1, archived: true });

    const shown = (await api.getDoc(companyId, d.id)).body.document;
    expect(codes(shown)).toContain("bankAccount.archived");
    const blocked = await api.issue(companyId, d.id, 1);
    expect(blocked.status).toBe(422);
    expect(codes(blocked.body)).toContain("bankAccount.archived");
    const [row] = await db.select().from(documents).where(eq(documents.id, d.id));
    expect(row).toMatchObject({ status: "draft", number: null });

    // An unrelated save keeps the (archived) link; newly choosing an archived account is refused.
    const kept = await api.patchDoc(companyId, d.id, {
      expectedVersion: 1,
      draft: input(cats, { notes: "Still archived" }),
    });
    expect(kept.status).toBe(200);
    expect(kept.body.document.draft.bankAccountId).toBe(a);
    const other = (await api.createDoc(companyId, input(cats))).body.document;
    const refused = await api.patchDoc(companyId, other.id, {
      expectedVersion: 1,
      draft: input(cats, { bankAccountId: a }),
    });
    expect(codes(refused.body)).toEqual(["bankAccount.archived"]);

    await api.patchDoc(companyId, d.id, {
      expectedVersion: 2,
      draft: input(cats, { bankAccountId: b }),
    });
    const issued = await api.issue(companyId, d.id, 3);
    expect(issued.status).toBe(200);
    // The blocked attempt used no number.
    expect(issued.body.document.number).toMatch(/0001$/);
    expect(issued.body.document.draft.bankAccounts).toEqual([FIXTURE_BANK_ACCOUNT_2]);
  });

  it("drafts with details entered before accounts existed keep them on save and can be issued", async () => {
    const { owner, companyId, cats } = await newCompany();
    const legacy = [{ bankName: "Old Bank", iban: FIXTURE_BANK_ACCOUNT_2.iban }];
    const draft = await createDraft(db, owner, companyId, input(cats));
    await db.update(documents).set({ bankAccounts: legacy }).where(eq(documents.id, draft.id));
    const saved = await updateDraft(db, owner, companyId, draft.id, 1, input(cats, { notes: "x" }));
    expect(saved.draft.bankAccounts).toEqual(legacy);
    expect(saved.draft.bankAccountId).toBeUndefined();
    const issued = await issueDocument(db, owner, companyId, draft.id, 2);
    expect(issued.draft.bankAccounts).toEqual(legacy);
  });

  it("derived invoices link the source's active account; credit notes keep the invoice's details", async () => {
    const { owner, companyId, cats } = await newCompany();
    const a = await addFixtureBankAccount(db, owner, companyId);
    const pf = await createDraft(
      db,
      owner,
      companyId,
      input(cats, { type: "proforma", bankAccountId: a }),
    );
    await issueDocument(db, owner, companyId, pf.id, 1);
    await updateBankAccount(db, owner, companyId, a, { expectedVersion: 1, label: "Fresh" });
    const inv = await deriveDraft(db, owner, companyId, pf.id, "invoice_from_proforma", {
      issueDate: "2026-03-05",
    });
    expect(inv.draft).toMatchObject({ bankAccountId: a, bankAccounts: [FIXTURE_BANK_ACCOUNT] });
    const issuedInv = await issueDocument(db, owner, companyId, inv.id, 1);

    await updateBankAccount(db, owner, companyId, a, { expectedVersion: 2, archived: true });
    const cn = await createCreditNoteDraft(db, owner, companyId, issuedInv.id, "full", {
      issueDate: "2026-03-10",
    });
    expect(cn.draft.bankAccounts).toEqual(issuedInv.draft.bankAccounts);
    expect(cn.draft.bankAccountId).toBeUndefined();
    expect(codes(cn)).not.toContain("bankAccount.archived");
    const later = await deriveDraft(db, owner, companyId, pf.id, "invoice_from_proforma", {
      issueDate: "2026-03-06",
    });
    // The source's account is archived now: the derived draft keeps the printed details unlinked.
    expect(later.draft.bankAccountId).toBeUndefined();
    expect(later.draft.bankAccounts).toEqual([FIXTURE_BANK_ACCOUNT]);
  });
});

describe("concurrent issuing and archiving", () => {
  it("an issue waiting on an archive sees the archived account and uses no number", async () => {
    const { owner, companyId, cats } = await newCompany();
    const a = await addFixtureBankAccount(db, owner, companyId);
    const draft = await createDraft(db, owner, companyId, input(cats, { bankAccountId: a }));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM company_bank_accounts WHERE id = $1 FOR UPDATE", [a]);
      await client.query(
        "UPDATE company_bank_accounts SET archived_at = now(), is_default = false, version = version + 1 WHERE id = $1",
        [a],
      );
      let settled = false;
      const pending = issueDocument(db, owner, companyId, draft.id, 1).finally(() => {
        settled = true;
      });
      pending.catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // blocked on the account lock
      await client.query("COMMIT");
      await expect(pending).rejects.toThrow(/bankAccount\.archived/);
    } finally {
      client.release();
    }
    const [row] = await db.select().from(documents).where(eq(documents.id, draft.id));
    expect(row).toMatchObject({ status: "draft", number: null });
  });

  it("racing issue and archive: either the issue completes with the details or fails without a number", async () => {
    const { owner, companyId, cats } = await newCompany();
    for (let i = 0; i < 5; i++) {
      const a = await addFixtureBankAccount(db, owner, companyId);
      const draft = await createDraft(db, owner, companyId, input(cats, { bankAccountId: a }));
      const [issued, archived] = await Promise.allSettled([
        issueDocument(db, owner, companyId, draft.id, 1),
        updateBankAccount(db, owner, companyId, a, { expectedVersion: 1, archived: true }),
      ]);
      expect(archived.status).toBe("fulfilled");
      const [row] = await db.select().from(documents).where(eq(documents.id, draft.id));
      if (issued.status === "fulfilled") {
        expect(row).toMatchObject({ status: "issued", bankAccounts: [FIXTURE_BANK_ACCOUNT] });
        expect(await verifyDocumentIntegrity(db, owner, companyId, draft.id)).toBe(true);
      } else {
        expect(issued.reason).toBeInstanceOf(DocumentValidationError);
        expect(row).toMatchObject({ status: "draft", number: null });
      }
    }
  });
});
