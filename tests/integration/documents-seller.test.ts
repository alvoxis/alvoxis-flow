import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCreditNoteDraft,
  createDraft,
  getDocument,
  issueDocument,
  updateDraft,
  verifyDocumentIntegrity,
} from "@/modules/documents/server/document-service";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { companies, documents, memberships, roles, users } from "@/server/db/schema";
import { ForbiddenError, TwoFactorRequiredError } from "@/server/errors";
import { updateCompanyProfile } from "@/server/tenancy/company-profile";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";
import { FIXTURE_SELLER_PROFILE, invoiceDraft } from "../support/document-fixtures";
import { openTestDb } from "./test-db";

/** Seller on documents = company profile at issue time. Synthetic data only. */
let db: Database;
let pool: Pool;
beforeAll(() => ({ db, pool } = openTestDb()));
afterAll(async () => pool.end());

const actorOf = (userId: string): Actor => ({ userId, twoFactorVerified: true });

async function newUser() {
  const [u] = await db
    .insert(users)
    .values({ email: `seller-${randomUUID()}@example.test` })
    .returning();
  return u!;
}

async function newCompany() {
  const owner = await newUser();
  const actor = actorOf(owner.id);
  const { companyId } = await createCompanyWithOwner(db, actor, {
    name: "Seller Co",
    country: "LV",
  });
  await db.update(companies).set(FIXTURE_SELLER_PROFILE).where(eq(companies.id, companyId));
  await ensureDefaultNumberSeries(db, actor, companyId);
  return { actor, owner, companyId };
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

function input(overrides: Parameters<typeof invoiceDraft>[0] = {}) {
  const { lines, relation: _r, ...rest } = invoiceDraft(overrides);
  return { ...rest, lines: lines.map(({ id: _id, sourceLineId: _s, ...l }) => l) };
}

const FIXTURE_SELLER = {
  name: "Example Workwear SIA",
  registrationNumber: "40000000000",
  vatNumber: "LV40000000000",
  address: { lines: ["Example street 1"], postalCode: "LV-1000", city: "Rīga", countryCode: "LV" },
};

async function storedRow(id: string) {
  const [row] = await db.select().from(documents).where(eq(documents.id, id));
  return row!;
}

describe("seller details from the company profile", () => {
  it("drafts take the seller identity from the profile; a client cannot supply another one", async () => {
    const { actor, companyId } = await newCompany();
    const draft = await createDraft(
      db,
      actor,
      companyId,
      input({
        seller: {
          name: "Somebody Else Ltd",
          registrationNumber: "99999999999",
          vatNumber: "LV99999999999",
          address: { lines: ["Fake street 9"], countryCode: "LV" },
          legalAddress: { lines: ["Elsewhere 1"], countryCode: "LV" },
          email: "sales@example.test",
          phone: "+371 20000000",
        },
      }),
    );
    // Identity from the profile; contact fields as entered; no foreign legal address.
    expect(draft.draft.seller).toEqual({
      ...FIXTURE_SELLER,
      email: "sales@example.test",
      phone: "+371 20000000",
    });
    expect(draft.number).toBeNull();

    // The same applies when a draft is edited.
    const edited = await updateDraft(
      db,
      actor,
      companyId,
      draft.id,
      draft.version,
      input({ seller: { name: "Edited Ltd", vatNumber: "LV11111111111" } }),
    );
    expect(edited.draft.seller).toMatchObject({
      name: "Example Workwear SIA",
      vatNumber: "LV40000000000",
    });
  });

  it("issuing freezes the profile as it is at issue time, in the row and in the hashed snapshot", async () => {
    const { actor, companyId } = await newCompany();
    const draft = await createDraft(db, actor, companyId, input());

    // Profile changed between draft and issue → the issued document shows the new details.
    const changed = await updateCompanyProfile(db, actor, companyId, {
      name: "Seller Co",
      legalName: "Example Workwear SIA (renamed)",
      addressLine1: "New street 5",
      city: "Liepāja",
      postalCode: "LV-3401",
    });
    expect(changed.ok).toBe(true);
    const issued = await issueDocument(db, actor, companyId, draft.id, draft.version);
    const expectedSeller = {
      ...FIXTURE_SELLER,
      name: "Example Workwear SIA (renamed)",
      address: {
        lines: ["New street 5"],
        postalCode: "LV-3401",
        city: "Liepāja",
        countryCode: "LV",
      },
      email: "billing@example.test",
    };
    const row = await storedRow(issued.id);
    expect(row.seller).toEqual(expectedSeller);
    expect((row.snapshot as { seller: unknown }).seller).toEqual(expectedSeller);
    expect(await verifyDocumentIntegrity(db, actor, companyId, issued.id)).toBe(true);
  });

  it("later profile changes never alter issued documents (seller and buyer stay as issued)", async () => {
    const { actor, companyId } = await newCompany();
    const d = await createDraft(db, actor, companyId, input());
    const issued = await issueDocument(db, actor, companyId, d.id, d.version);
    const before = await storedRow(issued.id);

    await updateCompanyProfile(db, actor, companyId, {
      name: "Changed",
      legalName: "Completely Different SIA",
      vatNumber: "LV12345678901",
      addressLine1: "Other street 2",
    });
    const after = await storedRow(issued.id);
    expect(after.seller).toEqual(before.seller);
    expect(after.buyer).toEqual(before.buyer);
    expect(after.snapshot).toEqual(before.snapshot);
    expect(after.contentHash).toBe(before.contentHash);
    expect((await getDocument(db, actor, companyId, issued.id)).draft.seller.name).toBe(
      "Example Workwear SIA",
    );
    expect(await verifyDocumentIntegrity(db, actor, companyId, issued.id)).toBe(true);

    // Issued rows stay protected by the database as well.
    await expect(
      db
        .update(documents)
        .set({ seller: { name: "Tampered" } })
        .where(eq(documents.id, issued.id)),
    ).rejects.toThrow();
  });

  it("derived drafts (credit note) use the current profile; the original keeps its snapshot", async () => {
    const { actor, companyId } = await newCompany();
    const d = await createDraft(db, actor, companyId, input());
    const invoice = await issueDocument(db, actor, companyId, d.id, d.version);
    await updateCompanyProfile(db, actor, companyId, {
      name: "Seller Co",
      legalName: "Renamed SIA",
    });

    const credit = await createCreditNoteDraft(db, actor, companyId, invoice.id, "full", {
      issueDate: "2026-03-10",
    });
    expect(credit.draft.seller.name).toBe("Renamed SIA");
    const issuedCredit = await issueDocument(db, actor, companyId, credit.id, credit.version);
    expect((await storedRow(issuedCredit.id)).seller).toMatchObject({ name: "Renamed SIA" });
    expect((await storedRow(invoice.id)).seller).toMatchObject({ name: "Example Workwear SIA" });
  });

  it("numbers are still allocated only at issue, in order, unaffected by profile changes", async () => {
    const { actor, companyId } = await newCompany();
    const a = await createDraft(db, actor, companyId, input());
    const b = await createDraft(db, actor, companyId, input());
    expect([a.number, b.number]).toEqual([null, null]);
    expect((await issueDocument(db, actor, companyId, b.id, b.version)).number).toBe(
      "INV-2026-0001",
    );
    await updateCompanyProfile(db, actor, companyId, { name: "Seller Co", legalName: "Next SIA" });
    expect((await issueDocument(db, actor, companyId, a.id, a.version)).number).toBe(
      "INV-2026-0002",
    );
  });

  it("without a profile address an invoice cannot be issued and no number is used", async () => {
    const { actor, companyId } = await newCompany();
    await db
      .update(companies)
      .set({ legalName: null, addressLine1: null, addressLine2: null })
      .where(eq(companies.id, companyId));
    const d = await createDraft(db, actor, companyId, input());
    expect(d.draft.seller.name).toBe("Seller Co"); // display name when no legal name is set
    expect(d.issues.map((i) => i.code)).toContain("seller.address.required");
    await expect(issueDocument(db, actor, companyId, d.id, d.version)).rejects.toThrow();
    expect((await storedRow(d.id)).number).toBeNull();
  });

  it("access: only members with document permissions; profile identity cannot be bypassed", async () => {
    const { owner, companyId } = await newCompany();
    // Accountants may create and issue documents but not edit the profile; through a document
    // they still cannot change the seller identity.
    const accountant = await member(companyId, "accountant");
    const d = await createDraft(db, accountant, companyId, input({ seller: { name: "Mine SIA" } }));
    expect(d.draft.seller.name).toBe("Example Workwear SIA");
    await expect(updateCompanyProfile(db, accountant, companyId, { name: "Mine" })).rejects.toThrow(
      ForbiddenError,
    );

    const warehouse = await member(companyId, "warehouse_employee");
    await expect(createDraft(db, warehouse, companyId, input())).rejects.toThrow(ForbiddenError);
    const stranger = actorOf((await newUser()).id);
    await expect(createDraft(db, stranger, companyId, input())).rejects.toThrow(ForbiddenError);
    // Another tenant's profile is never used: the stranger's own company stays separate.
    await expect(
      createDraft(db, { userId: owner.id, twoFactorVerified: false }, companyId, input()),
    ).rejects.toThrow(TwoFactorRequiredError);

    await db.update(companies).set({ archivedAt: new Date() }).where(eq(companies.id, companyId));
    await expect(createDraft(db, actorOf(owner.id), companyId, input())).rejects.toThrow(
      ForbiddenError,
    );
  });
});
