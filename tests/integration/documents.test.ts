import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { auditLogs, documentLines, documents, memberships, roles, users } from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";
import {
  createCreditNoteDraft,
  createDraft,
  deleteDraft,
  deriveDraft,
  getDocument,
  issueDocument,
  updateDraft,
  verifyDocumentIntegrity,
} from "@/modules/documents/server/document-service";
import {
  DocumentNotFoundError,
  DocumentStateError,
  DocumentValidationError,
  DocumentVersionConflictError,
} from "@/modules/documents/server/errors";
import {
  createNumberSeries,
  ensureDefaultNumberSeries,
} from "@/modules/documents/server/numbering-service";
import { DocumentRuleError, type DraftInput } from "@/modules/documents/domain";
import { FIXTURE_TAX, invoiceDraft } from "../support/document-fixtures";
import { openTestDb } from "./test-db";

let db: Database;
let pool: Pool;
beforeAll(() => ({ db, pool } = openTestDb()));
afterAll(async () => pool.end());

const actorOf = (userId: string): Actor => ({ userId, twoFactorVerified: true });

async function newCompany() {
  const [owner] = await db
    .insert(users)
    .values({ email: `owner-${randomUUID()}@example.test` })
    .returning();
  const actor = actorOf(owner!.id);
  const { companyId } = await createCompanyWithOwner(db, actor, {
    name: "Fixture Company",
    country: "LV",
  });
  await ensureDefaultNumberSeries(db, actor, companyId);
  return { actor, companyId };
}

async function addMember(companyId: string, roleKey: string) {
  const [u] = await db
    .insert(users)
    .values({ email: `m-${randomUUID()}@example.test` })
    .returning();
  const [role] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.companyId, companyId), eq(roles.key, roleKey)));
  await db.insert(memberships).values({ companyId, userId: u!.id, roleId: role!.id });
  return actorOf(u!.id);
}

/** Domain fixture → untrusted input shape (no ids). */
function input(overrides: Parameters<typeof invoiceDraft>[0] = {}): DraftInput {
  const { lines, relation: _r, ...rest } = invoiceDraft(overrides);
  return { ...rest, lines: lines.map(({ id: _id, sourceLineId: _s, ...l }) => l) };
}

async function issuedInvoice(
  companyId: string,
  actor: Actor,
  overrides: Parameters<typeof invoiceDraft>[0] = {},
) {
  const draft = await createDraft(db, actor, companyId, input(overrides));
  return issueDocument(db, actor, companyId, draft.id, draft.version);
}

describe("drafts and issuing", () => {
  it("creates a draft without a number and issues it with totals, snapshot and hash", async () => {
    const { actor, companyId } = await newCompany();
    const draft = await createDraft(db, actor, companyId, input());
    expect(draft).toMatchObject({ status: "draft", number: null, version: 1, issues: [] });
    expect(draft.totals?.grossTotal).toBe("1320.00");

    const doc = await issueDocument(db, actor, companyId, draft.id, 1);
    expect(doc.status).toBe("issued");
    expect(doc.number).toBe("INV-2026-0001");
    expect(doc.totals).toMatchObject({
      netTotal: "1100.00",
      taxTotal: "220.00",
      grossTotal: "1320.00",
      currency: "EUR",
    });
    expect(doc.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyDocumentIntegrity(db, actor, companyId, doc.id)).toBe(true);

    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect([row!.netTotal, row!.taxTotal, row!.grossTotal]).toEqual([
      "1100.00",
      "220.00",
      "1320.00",
    ]);
    const lines = await db.select().from(documentLines).where(eq(documentLines.documentId, doc.id));
    expect(lines.map((l) => l.netAmount).sort()).toEqual(["450.00", "650.00"]);

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, companyId), eq(auditLogs.entityId, doc.id)));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["document.draft_created", "document.issued"]),
    );
  });

  it("numbers sequentially per series and restarts yearly", async () => {
    const { actor, companyId } = await newCompany();
    const a = await issuedInvoice(companyId, actor, {
      issueDate: "2026-12-30",
      dueDate: "2027-01-10",
    });
    const b = await issuedInvoice(companyId, actor, {
      issueDate: "2026-12-31",
      dueDate: "2027-01-10",
    });
    const c = await issuedInvoice(companyId, actor, {
      issueDate: "2027-01-02",
      dueDate: "2027-01-10",
    });
    expect([a.number, b.number, c.number]).toEqual([
      "INV-2026-0001",
      "INV-2026-0002",
      "INV-2027-0001",
    ]);
  });

  it("supports custom series patterns like the ones seen on paper invoices", async () => {
    const { actor, companyId } = await newCompany();
    const series = await createNumberSeries(db, actor, companyId, {
      documentType: "proforma",
      name: "Short",
      pattern: "{seq}/{yyyy}",
      resetPolicy: "yearly",
    });
    const draft = await createDraft(
      db,
      actor,
      companyId,
      input({ type: "proforma", dueDate: undefined, validUntil: "2026-03-30" }),
      { seriesId: series.id },
    );
    expect((await issueDocument(db, actor, companyId, draft.id, 1)).number).toBe("1/2026");
    await expect(
      createNumberSeries(db, actor, companyId, {
        documentType: "invoice",
        name: "Bad",
        pattern: "INV",
        resetPolicy: "never",
      }),
    ).rejects.toThrow(DocumentStateError);
  });

  it("allocates unique, gap-free numbers under concurrent issuing", async () => {
    const { actor, companyId } = await newCompany();
    const drafts = await Promise.all(
      Array.from({ length: 6 }, () => createDraft(db, actor, companyId, input())),
    );
    const issued = await Promise.all(
      drafts.map((d) => issueDocument(db, actor, companyId, d.id, d.version)),
    );
    expect(issued.map((d) => d.number).sort()).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => `INV-2026-000${n}`),
    );
  });

  it("does not consume a number when issuing fails validation", async () => {
    const { actor, companyId } = await newCompany();
    const bad = await createDraft(db, actor, companyId, input({ seller: { name: "" } }));
    expect(bad.issues.map((i) => i.code)).toContain("seller.name.required");
    await expect(issueDocument(db, actor, companyId, bad.id, 1)).rejects.toThrow(
      DocumentValidationError,
    );
    expect((await issuedInvoice(companyId, actor)).number).toBe("INV-2026-0001");
  });

  it("versions drafts and rejects stale updates", async () => {
    const { actor, companyId } = await newCompany();
    const d = await createDraft(db, actor, companyId, input());
    const v2 = await updateDraft(
      db,
      actor,
      companyId,
      d.id,
      1,
      input({ notes: "Updated", lines: invoiceDraft().lines.slice(0, 1) }),
    );
    expect(v2.version).toBe(2);
    expect(v2.draft.lines).toHaveLength(1);
    await expect(updateDraft(db, actor, companyId, d.id, 1, input())).rejects.toThrow(
      DocumentVersionConflictError,
    );
    await expect(issueDocument(db, actor, companyId, d.id, 1)).rejects.toThrow(
      DocumentVersionConflictError,
    );
    await expect(
      updateDraft(db, actor, companyId, d.id, 2, input({ type: "proforma" })),
    ).rejects.toThrow(/type cannot change/);
  });

  it("keeps PLN documents in PLN and never mixes currencies in totals", async () => {
    const { actor, companyId } = await newCompany();
    const pln = await issuedInvoice(companyId, actor, { currency: "PLN" });
    const eur = await issuedInvoice(companyId, actor);
    expect(pln.totals?.currency).toBe("PLN");
    expect(eur.totals?.currency).toBe("EUR");
    const rows = await db
      .select({ currency: documents.currency, gross: documents.grossTotal })
      .from(documents)
      .where(eq(documents.companyId, companyId));
    expect(rows.map((r) => r.currency).sort()).toEqual(["EUR", "PLN"]);
  });

  it("preserves the exchange-rate snapshot on issue", async () => {
    const { actor, companyId } = await newCompany();
    const rate = {
      from: "EUR" as const,
      to: "PLN" as const,
      rate: "4.2500",
      rateDate: "2026-03-01",
      source: { kind: "manual" as const, enteredByUserId: actor.userId },
    };
    const doc = await issuedInvoice(companyId, actor, { exchangeRate: rate });
    expect(doc.draft.exchangeRate).toEqual(rate);
    expect(doc.totals?.converted).toMatchObject({ currency: "PLN", grossTotal: "5610.00" });
  });
});

describe("immutability", () => {
  it("blocks any database-level change or deletion of issued documents and their lines", async () => {
    const { actor, companyId } = await newCompany();
    const doc = await issuedInvoice(companyId, actor);
    await expect(
      db.update(documents).set({ notes: "tampered" }).where(eq(documents.id, doc.id)),
    ).rejects.toThrow();
    await expect(db.delete(documents).where(eq(documents.id, doc.id))).rejects.toThrow();
    await expect(
      db.update(documentLines).set({ quantity: "999" }).where(eq(documentLines.documentId, doc.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(documentLines).where(eq(documentLines.documentId, doc.id)),
    ).rejects.toThrow();
    await expect(
      db
        .insert(documentLines)
        .values({
          companyId,
          documentId: doc.id,
          position: 99,
          description: "x",
          quantity: "1",
          unitPrice: "1",
        }),
    ).rejects.toThrow();
    await expect(updateDraft(db, actor, companyId, doc.id, 1, input())).rejects.toThrow(
      /cannot be edited/,
    );
    await expect(deleteDraft(db, actor, companyId, doc.id)).rejects.toThrow(/cannot be deleted/);
    await expect(issueDocument(db, actor, companyId, doc.id, 1)).rejects.toThrow(/already issued/);
  });

  it("refuses to insert documents directly in issued state", async () => {
    const { companyId } = await newCompany();
    await expect(
      db.execute(sql`insert into documents (company_id, type, status, language, currency, issue_date, seller, buyer, number, issued_at, content_hash, snapshot)
        values (${companyId}, 'invoice', 'issued', 'en', 'EUR', '2026-01-01', '{}', '{}', 'X-1', now(), 'h', '{}')`),
    ).rejects.toThrow();
  });

  it("allows deleting drafts", async () => {
    const { actor, companyId } = await newCompany();
    const d = await createDraft(db, actor, companyId, input());
    await deleteDraft(db, actor, companyId, d.id);
    await expect(getDocument(db, actor, companyId, d.id)).rejects.toThrow(DocumentNotFoundError);
  });
});

describe("credit notes and derived documents", () => {
  it("credits an issued invoice, links it, and enforces remaining amounts at draft and issue time", async () => {
    const { actor, companyId } = await newCompany();
    const inv = await issuedInvoice(companyId, actor);
    const l2 = inv.draft.lines[1]!.id;

    const cn1 = await createCreditNoteDraft(
      db,
      actor,
      companyId,
      inv.id,
      [{ sourceLineId: l2, quantity: "6" }],
      { issueDate: "2026-03-10" },
    );
    const cn2 = await createCreditNoteDraft(
      db,
      actor,
      companyId,
      inv.id,
      [{ sourceLineId: l2, quantity: "6" }],
      { issueDate: "2026-03-10" },
    );
    const issued1 = await issueDocument(db, actor, companyId, cn1.id, 1);
    expect(issued1.number).toBe("CN-2026-0001");
    expect(issued1.draft.relation).toMatchObject({
      kind: "credits",
      documentId: inv.id,
      documentNumber: "INV-2026-0001",
    });
    expect(issued1.totals?.grossTotal).toBe("-324.00");

    // Each draft was within limits on its own, but together they exceed the line → second issue fails.
    await expect(issueDocument(db, actor, companyId, cn2.id, 1)).rejects.toThrow(DocumentRuleError);
    // Building a new draft beyond what remains is refused immediately.
    await expect(
      createCreditNoteDraft(db, actor, companyId, inv.id, [{ sourceLineId: l2, quantity: "5" }], {
        issueDate: "2026-03-10",
      }),
    ).rejects.toThrow(/remaining/);

    const rest = await createCreditNoteDraft(db, actor, companyId, inv.id, "full", {
      issueDate: "2026-03-11",
    });
    const issuedRest = await issueDocument(db, actor, companyId, rest.id, 1);
    expect(issuedRest.totals?.grossTotal).toBe("-996.00"); // 1320 − 324
    const original = await getDocument(db, actor, companyId, inv.id);
    expect(original.contentHash).toBe(inv.contentHash); // original untouched
  });

  it("refuses credit notes for drafts or proformas, and via the generic draft API", async () => {
    const { actor, companyId } = await newCompany();
    const draft = await createDraft(db, actor, companyId, input());
    await expect(
      createCreditNoteDraft(db, actor, companyId, draft.id, "full", { issueDate: "2026-03-10" }),
    ).rejects.toThrow(/not issued/);
    await expect(createDraft(db, actor, companyId, input({ type: "credit_note" }))).rejects.toThrow(
      /issued invoice/,
    );
  });

  it("keeps the invoice currency and rate on credit notes even if the draft is edited", async () => {
    const { actor, companyId } = await newCompany();
    const inv = await issuedInvoice(companyId, actor);
    const cn = await createCreditNoteDraft(db, actor, companyId, inv.id, "full", {
      issueDate: "2026-03-10",
    });
    const { relation: _r, lines, ...rest } = cn.draft;
    const edited = await updateDraft(db, actor, companyId, cn.id, 1, {
      ...rest,
      currency: "PLN",
      lines: lines.map(({ id: _i, sourceLineId: _s, ...l }) => l),
    });
    await expect(issueDocument(db, actor, companyId, cn.id, edited.version)).rejects.toThrow(
      /currency must match/,
    );
  });

  it("derives delivery notes, invoices from proformas and replacement invoices", async () => {
    const { actor, companyId } = await newCompany();
    const inv = await issuedInvoice(companyId, actor);
    const dn = await deriveDraft(db, actor, companyId, inv.id, "delivery_note", {
      issueDate: "2026-03-03",
    });
    const issuedDn = await issueDocument(db, actor, companyId, dn.id, 1);
    expect(issuedDn).toMatchObject({ number: "DN-2026-0001", totals: null });
    expect(issuedDn.draft.lines.every((l) => l.unitPrice === null)).toBe(true);

    const pf = await createDraft(
      db,
      actor,
      companyId,
      input({ type: "proforma", dueDate: undefined }),
    );
    const issuedPf = await issueDocument(db, actor, companyId, pf.id, 1);
    const fromPf = await deriveDraft(db, actor, companyId, issuedPf.id, "invoice_from_proforma", {
      issueDate: "2026-03-05",
      dueDate: "2026-03-20",
    });
    expect(fromPf.draft).toMatchObject({
      type: "invoice",
      relation: { kind: "converted_from", documentId: issuedPf.id },
    });

    const repl = await deriveDraft(db, actor, companyId, inv.id, "replacement_invoice", {
      issueDate: "2026-03-12",
      dueDate: "2026-03-26",
    });
    expect(repl).toMatchObject({
      status: "draft",
      number: null,
      draft: { relation: { kind: "replaces", documentId: inv.id } },
    });
  });
});

describe("authorization and tenant isolation", () => {
  it("lets managers draft but only approvers issue; warehouse staff can only view", async () => {
    const { actor: owner, companyId } = await newCompany();
    const manager = await addMember(companyId, "manager");
    const accountant = await addMember(companyId, "accountant");
    const warehouse = await addMember(companyId, "warehouse_employee");

    const d = await createDraft(db, manager, companyId, input());
    await expect(issueDocument(db, manager, companyId, d.id, 1)).rejects.toThrow(ForbiddenError);
    await expect(createDraft(db, warehouse, companyId, input())).rejects.toThrow(ForbiddenError);
    const issued = await issueDocument(db, accountant, companyId, d.id, 1);
    await expect(getDocument(db, warehouse, companyId, issued.id)).resolves.toMatchObject({
      number: "INV-2026-0001",
    });
    await expect(
      createNumberSeries(db, accountant, companyId, {
        documentType: "invoice",
        name: "x",
        pattern: "{seq}",
        resetPolicy: "never",
      }),
    ).rejects.toThrow(ForbiddenError);
    expect(owner).toBeDefined();
  });

  it("never exposes or links documents across companies", async () => {
    const a = await newCompany();
    const b = await newCompany();
    const invA = await issuedInvoice(a.companyId, a.actor);

    await expect(getDocument(db, b.actor, a.companyId, invA.id)).rejects.toThrow(ForbiddenError);
    await expect(getDocument(db, b.actor, b.companyId, invA.id)).rejects.toThrow(
      DocumentNotFoundError,
    );
    await expect(
      createCreditNoteDraft(db, b.actor, b.companyId, invA.id, "full", { issueDate: "2026-03-10" }),
    ).rejects.toThrow(DocumentNotFoundError);

    // Database level: a document of company B cannot reference company A's invoice.
    await expect(
      db.insert(documents).values({
        companyId: b.companyId,
        type: "credit_note",
        language: "en",
        currency: "EUR",
        issueDate: "2026-03-10",
        seller: { name: "x" },
        buyer: { name: "y" },
        relationKind: "credits",
        relatedDocumentId: invA.id,
      }),
    ).rejects.toThrow();
  });
});

describe("tax presentation", () => {
  it("stores separate tax summary rows with notes", async () => {
    const { actor, companyId } = await newCompany();
    const doc = await issuedInvoice(companyId, actor, {
      lines: [
        {
          id: "a",
          kind: "item",
          description: "Taxed",
          quantity: "1",
          unitPrice: "100.00",
          taxCategory: FIXTURE_TAX.standard20,
        },
        {
          id: "b",
          kind: "item",
          description: "Exempt",
          quantity: "1",
          unitPrice: "50.00",
          taxCategory: FIXTURE_TAX.exempt,
        },
      ],
    });
    const [row] = await db
      .select({ taxSummary: documents.taxSummary })
      .from(documents)
      .where(eq(documents.id, doc.id));
    expect(row!.taxSummary).toEqual([
      expect.objectContaining({ code: "T20", taxableAmount: "100.00", taxAmount: "20.00" }),
      expect.objectContaining({
        code: "EX",
        kind: "exempt",
        taxAmount: "0.00",
        note: FIXTURE_TAX.exempt.note,
      }),
    ]);
  });
});
