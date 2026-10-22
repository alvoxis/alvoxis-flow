import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchDocuments } from "@/modules/documents/server/document-service";
import { EMPTY_DOCUMENT_QUERY } from "@/features/documents/list-query";
import { type Database } from "@/server/db/client";
import { companies, documents, memberships, users } from "@/server/db/schema";
import {
  seedSyntheticData,
  TEST_COMPANIES,
  TestDataError,
} from "@/server/test-data/synthetic-data";
import { openTestDb } from "./test-db";

/** The synthetic test-data seed (scripts/seed-test-data.ts) against a real database. */
let db: Database;
let pool: Pool;
beforeAll(() => {
  ({ db, pool } = openTestDb());
});
afterAll(async () => pool.end());

async function testUser(email = `tester-${randomUUID()}@example.test`) {
  const [u] = await db.insert(users).values({ email }).returning();
  return u!;
}

describe("synthetic test data", { timeout: 120_000 }, () => {
  it("creates the fictitious companies and documents through the regular services, once", async () => {
    const user = await testUser();
    const first = await seedSyntheticData(db, user.email.toUpperCase());
    expect(first.companies.map((c) => [c.name, c.created])).toEqual(
      TEST_COMPANIES.map((c) => [c.name, true]),
    );
    // 20 + 4 EUR/PLN invoices, 3 drafts, a proforma, a delivery note and 2 credit notes.
    expect(first.companies[0]!.documents).toBe(31);
    expect(first.companies[1]!.documents).toBe(3);

    const owned = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .innerJoin(memberships, eq(memberships.companyId, companies.id))
      .where(eq(memberships.userId, user.id));
    expect(owned.map((c) => c.name).sort()).toEqual(TEST_COMPANIES.map((c) => c.name).sort());
    const main = owned.find((c) => c.name === TEST_COMPANIES[0]!.name)!;
    const rows = await db
      .select({ type: documents.type, status: documents.status, currency: documents.currency })
      .from(documents)
      .where(eq(documents.companyId, main.id));
    const count = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred).length;
    expect(count((r) => r.type === "invoice" && r.status === "issued")).toBe(24);
    expect(count((r) => r.currency === "PLN")).toBe(4);
    expect(count((r) => r.status === "draft")).toBe(3);
    expect(count((r) => r.type === "credit_note" && r.status === "issued")).toBe(2);
    // Enough to page through the list (25 per page), as the owner sees it.
    const page = await searchDocuments(
      db,
      { userId: user.id, twoFactorVerified: true },
      main.id,
      EMPTY_DOCUMENT_QUERY,
    );
    expect(page.total).toBe(31);
    expect(page.documents).toHaveLength(25);

    // Running again changes nothing.
    const again = await seedSyntheticData(db, user.email);
    expect(again.companies.every((c) => !c.created)).toBe(true);
    const total = await db
      .select({ id: documents.id })
      .from(documents)
      .where(
        inArray(
          documents.companyId,
          owned.map((c) => c.id),
        ),
      );
    expect(total).toHaveLength(34);
  });

  it("refuses real-looking addresses and users that do not exist", async () => {
    await expect(seedSyntheticData(db, "someone@gmail.com")).rejects.toThrow(TestDataError);
    await expect(seedSyntheticData(db, "@example.test")).rejects.toThrow(TestDataError);
    await expect(seedSyntheticData(db, `missing-${randomUUID()}@example.test`)).rejects.toThrow(
      /sign up/,
    );
  });

  it("only touches the given user's own companies", async () => {
    const a = await testUser();
    const b = await testUser();
    await seedSyntheticData(db, a.email);
    const ofB = await db
      .select({ id: memberships.companyId })
      .from(memberships)
      .where(and(eq(memberships.userId, b.id)));
    expect(ofB).toEqual([]);
  });
});
