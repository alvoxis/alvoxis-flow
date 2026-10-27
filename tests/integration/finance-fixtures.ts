import { eq } from "drizzle-orm";
import { createDraft, issueDocument } from "@/modules/documents/server/document-service";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { companies } from "@/server/db/schema";
import { FIXTURE_SELLER_PROFILE, invoiceDraft, line } from "../support/document-fixtures";
import {
  addFixtureTaxCategories,
  type FixtureCategoryIds,
  withCategoryIds,
} from "../support/tax-category-fixtures";

/**
 * Companies that can issue invoices, and issued invoices with chosen amounts, through the real
 * document services. Synthetic data only.
 */
export async function prepareInvoicing(db: Database, owner: Actor, companyId: string) {
  await db.update(companies).set(FIXTURE_SELLER_PROFILE).where(eq(companies.id, companyId));
  await ensureDefaultNumberSeries(db, owner, companyId);
  return addFixtureTaxCategories(db, owner, companyId);
}

/**
 * Issues an invoice with one line of `net` at the fixture's 20 % rate (gross = net × 1.2), or
 * zero-rated when `zero` is set (gross = net).
 */
export async function issuedInvoice(
  db: Database,
  owner: Actor,
  companyId: string,
  cats: FixtureCategoryIds,
  opts: {
    net: string;
    issueDate?: string;
    dueDate?: string | null;
    currency?: "EUR" | "PLN";
    zero?: boolean;
    buyer?: string;
    description?: string;
  },
) {
  const {
    lines: _l,
    relation: _r,
    bankAccounts: _b,
    dueDate,
    ...rest
  } = invoiceDraft({
    issueDate: opts.issueDate ?? "2026-03-02",
    dueDate: opts.dueDate === undefined ? "2026-03-16" : (opts.dueDate ?? undefined),
    currency: opts.currency ?? "EUR",
    ...(opts.buyer ? { buyer: { name: opts.buyer } } : {}),
  });
  const lines = withCategoryIds(
    [
      line({
        id: "x",
        description: opts.description ?? "Fixture service",
        quantity: "1",
        unitPrice: opts.net,
        ...(opts.zero
          ? {
              taxCategory: {
                code: "Z0",
                kind: "zero_rated",
                ratePercent: "0",
                label: "Fixture zero-rated",
                note: "Fixture note: zero-rated supply.",
              },
            }
          : {}),
      }),
    ].map(({ id: _id, sourceLineId: _s, ...l }) => l),
    cats,
  );
  const draft = await createDraft(db, owner, companyId, {
    ...rest,
    ...(dueDate ? { dueDate } : {}),
    lines,
  });
  const issued = await issueDocument(db, owner, companyId, draft.id, draft.version);
  return issued;
}
