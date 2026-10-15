import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { auditLogs, documents, memberships, roles, users } from "@/server/db/schema";
import { ForbiddenError } from "@/server/errors";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";
import { type ImportDecisions } from "@/modules/documents/import";
import { renderDocumentPdf } from "@/modules/documents/pdf/render";
import { sampleModels } from "@/modules/documents/sample/sample-documents";
import { createDraft, issueDocument } from "@/modules/documents/server/document-service";
import { createDraftFromImport, previewPdfImport } from "@/modules/documents/server/import-service";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { FIXTURE_TAX } from "../support/document-fixtures";
import { openTestDb } from "./test-db";

let db: Database;
let pool: Pool;
let pdf: Uint8Array;
beforeAll(async () => {
  ({ db, pool } = openTestDb());
  pdf = new Uint8Array(await renderDocumentPdf(sampleModels("lv").invoice!));
});
afterAll(async () => pool.end());

async function newCompany() {
  const [owner] = await db
    .insert(users)
    .values({ email: `imp-${randomUUID()}@example.test` })
    .returning();
  const actor: Actor = { userId: owner!.id, twoFactorVerified: true };
  const { companyId } = await createCompanyWithOwner(db, actor, {
    name: "Import Co",
    country: "LV",
  });
  await ensureDefaultNumberSeries(db, actor, companyId);
  return { actor, companyId };
}

const decisions: ImportDecisions = {
  type: "invoice",
  language: "lv",
  currency: "EUR",
  issueDate: "2026-03-02",
  dueDate: "2026-03-16",
  seller: {
    name: "Example Workwear SIA",
    address: { lines: ["Parauga iela 1"], city: "Rīga", countryCode: "LV" },
  },
  buyer: { name: "Sample Shipping Agency Ltd" },
  bankAccounts: [{ iban: "LV80BANK0000435195001" }],
  defaultTaxCategory: FIXTURE_TAX.standard20,
  acknowledgedFlags: [],
};

describe("PDF import", { timeout: 30_000 }, () => {
  it("previews without creating anything and audits only metadata", async () => {
    const { actor, companyId } = await newCompany();
    const review = await previewPdfImport(db, actor, companyId, pdf);
    expect(review).toMatchObject({
      status: "needs_review",
      number: { value: "INV-2026-0001" },
      duplicates: [],
    });
    expect(review.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await db.$count(documents, eq(documents.companyId, companyId))).toBe(0);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.companyId, companyId), eq(auditLogs.action, "document.import_previewed")),
      );
    expect(audit!.entityId).toBe(review.fileSha256);
    expect(JSON.stringify(audit!.metadata)).not.toContain("Sample Shipping"); // no document content in the audit trail
  });

  it("creates a draft only from reviewed decisions and detects re-imports of the same file", async () => {
    const { actor, companyId } = await newCompany();
    const review = await previewPdfImport(db, actor, companyId, pdf);
    const required = review.flags.filter((f) => f.severity !== "info").map((f) => f.code);

    // A clean ALVOXIS Flow PDF only produces informational findings (e.g. "confirm tax treatment").
    expect(required).toEqual([]);
    expect(review.flags.map((f) => f.code)).toContain("tax.treatmentRequiresConfirmation");
    const draft = await createDraftFromImport(db, actor, companyId, pdf, decisions);
    expect(draft).toMatchObject({ status: "draft", number: null });
    expect(draft.draft.lines).toHaveLength(4);
    expect(draft.totals?.currency).toBe("EUR");

    const again = await previewPdfImport(db, actor, companyId, pdf);
    expect(again.duplicates).toEqual([
      expect.objectContaining({
        documentId: draft.id,
        strength: "certain",
        reasons: expect.arrayContaining(["same_file"]),
      }),
    ]);
    await expect(
      createDraftFromImport(db, actor, companyId, pdf, {
        ...decisions,
        acknowledgedFlags: [...required, "duplicate.possible"],
      }),
    ).rejects.toThrow(/already exist/);
  });

  it("finds an existing issued document with the same number and date", async () => {
    const { actor, companyId } = await newCompany();
    const { lines, ...rest } = sampleModels("en").invoice!.document;
    const d = await createDraft(db, actor, companyId, {
      ...rest,
      lines: lines.map(({ id: _i, ...l }) => l),
    });
    const issued = await issueDocument(db, actor, companyId, d.id, 1);
    expect(issued.number).toBe("INV-2026-0001");

    const review = await previewPdfImport(db, actor, companyId, pdf);
    expect(review.duplicates[0]).toMatchObject({ documentId: issued.id, strength: "certain" });
    expect(review.flags).toContainEqual(
      expect.objectContaining({ code: "duplicate.possible", severity: "warning" }),
    );
  });

  it("does not look for duplicates in other companies", async () => {
    const a = await newCompany();
    const b = await newCompany();
    const review = await previewPdfImport(db, a.actor, a.companyId, pdf);
    await createDraftFromImport(db, a.actor, a.companyId, pdf, {
      ...decisions,
      acknowledgedFlags: review.flags.map((f) => f.code),
    });
    expect((await previewPdfImport(db, b.actor, b.companyId, pdf)).duplicates).toEqual([]);
  });

  it("rejects non-PDF and oversized files, and users without permission", async () => {
    const { actor, companyId } = await newCompany();
    await expect(
      previewPdfImport(db, actor, companyId, new TextEncoder().encode("hello")),
    ).rejects.toThrow(/not a PDF/);
    await expect(
      previewPdfImport(db, actor, companyId, new Uint8Array(11 * 1024 * 1024)),
    ).rejects.toThrow(/MB/);

    const [u] = await db
      .insert(users)
      .values({ email: `wh-${randomUUID()}@example.test` })
      .returning();
    const [role] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.companyId, companyId), eq(roles.key, "warehouse_employee")));
    await db.insert(memberships).values({ companyId, userId: u!.id, roleId: role!.id });
    await expect(
      previewPdfImport(db, { userId: u!.id, twoFactorVerified: false }, companyId, pdf),
    ).rejects.toThrow(ForbiddenError);
  });
});
