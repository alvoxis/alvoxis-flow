import "server-only";
import { and, eq } from "drizzle-orm";
import { createBankAccount } from "@/modules/documents/server/bank-account-service";
import {
  createCreditNoteDraft,
  createDraft,
  getDocument,
  issueDocument,
} from "@/modules/documents/server/document-service";
import { ensureDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { createTaxCategory } from "@/modules/documents/server/tax-category-service";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { companies, memberships, users } from "@/server/db/schema";
import { updateCompanyProfile } from "@/server/tenancy/company-profile";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";

/**
 * FICTITIOUS test data for a test environment (docs/TEST-ENVIRONMENT.md §12). Every company,
 * buyer, address and amount is invented; the IBANs are the public ISO 13616 documentation
 * examples; the tax categories are arbitrary values labelled "TEST", not real country rates.
 *
 * The data is created for an existing, already registered user with an `…@example.test` address
 * (the test user signs up through the app as usual: email verification and 2FA are not touched).
 * It goes through the regular services, so every business rule applies. Running it again for the
 * same user adds nothing: companies are matched by name among the user's memberships.
 */

export const TEST_EMAIL_DOMAIN = "@example.test";

/** Thrown for every refusal; the message never contains connection details. */
export class TestDataError extends Error {
  override name = "TestDataError";
}

interface CompanySpec {
  name: string;
  country: "LV" | "LT" | "EE" | "PL";
  profile: Record<string, string>;
  buyers: readonly string[];
  /** Issued EUR invoices, then PLN ones, drafts, a proforma and a delivery note. */
  invoicesEur: number;
  invoicesPln: number;
  drafts: number;
  creditNotes: boolean;
}

/** Two companies of the same owner: one with enough documents to page (> 25), one small. */
export const TEST_COMPANIES: readonly CompanySpec[] = [
  {
    name: "Baltic Workwear SIA (TEST)",
    country: "LV",
    profile: {
      legalName: "SIA Baltic Workwear (TEST)",
      registrationNumber: "40000000004",
      vatNumber: "LV40000000004",
      addressLine1: "Testa iela 1",
      postalCode: "LV-1001",
      city: "Rīga",
    },
    buyers: [
      "Amber Coast Logistics SIA (TEST)",
      "Daugava Builders SIA (TEST)",
      "Kurzeme Fishery SIA (TEST)",
      "Nordic Office Supplies AS (TEST)",
      "Vistula Trading Sp. z o.o. (TEST)",
    ],
    invoicesEur: 20,
    invoicesPln: 4,
    drafts: 3,
    creditNotes: true,
  },
  {
    name: "Nemunas Tools UAB (TEST)",
    country: "LT",
    profile: {
      legalName: "UAB Nemunas Tools (TEST)",
      registrationNumber: "300000000",
      vatNumber: "LT100000000010",
      addressLine1: "Testo g. 2",
      postalCode: "LT-01100",
      city: "Vilnius",
    },
    buyers: ["Riga Hardware SIA (TEST)", "Tallinn Workshop OÜ (TEST)"],
    invoicesEur: 2,
    invoicesPln: 0,
    drafts: 1,
    creditNotes: false,
  },
];

const TAX_CATEGORIES = [
  { code: "TEST20", kind: "standard", ratePercent: "20", label: "TEST 20% (not a real rate)" },
  { code: "TEST5", kind: "standard", ratePercent: "5", label: "TEST 5% (not a real rate)" },
  {
    code: "TEST0",
    kind: "zero_rated",
    ratePercent: "0",
    label: "TEST zero-rated",
    note: "TEST note: zero-rated supply (synthetic).",
  },
] as const;

const BANK_ACCOUNTS = [
  // ISO 13616 documentation examples, not real accounts.
  {
    label: "TEST EUR",
    bankName: "Example Bank AS (TEST)",
    iban: "LV80BANK0000435195001",
    isDefault: true,
  },
  { label: "TEST PLN", bankName: "Przykładowy Bank (TEST)", iban: "PL61109010140000071219812874" },
];

const ITEMS = [
  { description: "Winter jacket (TEST)", unit: "pcs", unitPrice: "65.00" },
  { description: "Safety boots (TEST)", unit: "pair", unitPrice: "45.00" },
  { description: "Work gloves (TEST)", unit: "pair", unitPrice: "7.50" },
  { description: "Delivery (TEST)", unit: "service", unitPrice: "25.00" },
] as const;

/** Dates in the first quarter of 2026, spread so that date filters and sorting have work to do. */
function issueDate(i: number): string {
  const day = (i * 3) % 28;
  const month = 1 + (Math.floor((i * 3) / 28) % 3);
  return `2026-${String(month).padStart(2, "0")}-${String(day + 1).padStart(2, "0")}`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface SeedSummary {
  owner: string;
  companies: { name: string; created: boolean; documents: number }[];
}

/** Creates the synthetic companies and documents for `ownerEmail` (an existing test user). */
export async function seedSyntheticData(db: Database, ownerEmail: string): Promise<SeedSummary> {
  const email = ownerEmail.trim().toLowerCase();
  if (!email.endsWith(TEST_EMAIL_DOMAIN) || email.length <= TEST_EMAIL_DOMAIN.length)
    throw new TestDataError(`The owner must be a test user with an ${TEST_EMAIL_DOMAIN} address`);
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!user)
    throw new TestDataError(
      "No such user: sign up with this address in the test environment first",
    );
  // The owner's own new companies; the services check permissions as for any owner.
  const actor: Actor = { userId: user.id, twoFactorVerified: true };

  const summary: SeedSummary = { owner: email, companies: [] };
  for (const spec of TEST_COMPANIES) {
    const [existing] = await db
      .select({ id: companies.id })
      .from(companies)
      .innerJoin(memberships, eq(memberships.companyId, companies.id))
      .where(and(eq(memberships.userId, user.id), eq(companies.name, spec.name)));
    if (existing) {
      summary.companies.push({ name: spec.name, created: false, documents: 0 });
      continue;
    }
    const documents = await seedCompany(db, actor, spec);
    summary.companies.push({ name: spec.name, created: true, documents });
  }
  return summary;
}

async function seedCompany(db: Database, actor: Actor, spec: CompanySpec): Promise<number> {
  const { companyId } = await createCompanyWithOwner(db, actor, {
    name: spec.name,
    country: spec.country,
  });
  const profile = await updateCompanyProfile(db, actor, companyId, {
    name: spec.name,
    addressLine2: "",
    ...spec.profile,
  });
  if (!profile.ok) throw new TestDataError(`Profile rejected: ${Object.keys(profile.fieldErrors)}`);
  await ensureDefaultNumberSeries(db, actor, companyId);

  const categories: string[] = [];
  for (const category of TAX_CATEGORIES)
    categories.push((await createTaxCategory(db, actor, companyId, category)).taxCategory.id);
  const accounts: string[] = [];
  for (const account of BANK_ACCOUNTS)
    accounts.push((await createBankAccount(db, actor, companyId, account)).id);

  let count = 0;
  let n = 0;
  const draft = async (
    type: "invoice" | "proforma" | "delivery_note",
    currency: "EUR" | "PLN",
    issue: boolean,
  ) => {
    const i = n++;
    const date = issueDate(i);
    const lines = ITEMS.slice(0, 1 + (i % ITEMS.length)).map((item, j) => ({
      kind: "item" as const,
      description: item.description,
      quantity: String(1 + ((i + j) % 9)),
      unit: item.unit,
      unitPrice: type === "delivery_note" ? null : item.unitPrice,
      taxCategoryId: type === "delivery_note" ? null : categories[(i + j) % categories.length]!,
    }));
    const doc = await createDraft(db, actor, companyId, {
      type,
      language: "en",
      currency,
      issueDate: date,
      dueDate: type === "invoice" ? addDays(date, 14) : undefined,
      buyer: {
        name: spec.buyers[i % spec.buyers.length]!,
        address: { lines: [`Synthetic street ${i + 1}`], city: "Test City", countryCode: "LV" },
        email: `buyer${i + 1}${TEST_EMAIL_DOMAIN}`,
      },
      buyerReference: `PO-TEST-${String(i + 1).padStart(3, "0")}`,
      paymentTerms: type === "invoice" ? "Payment within 14 days (TEST)" : undefined,
      bankAccountId: type === "delivery_note" ? null : accounts[currency === "PLN" ? 1 : 0],
      lines,
    });
    count++;
    return issue ? issueDocument(db, actor, companyId, doc.id, doc.version) : doc;
  };

  const invoices = [];
  for (let k = 0; k < spec.invoicesEur; k++) invoices.push(await draft("invoice", "EUR", true));
  for (let k = 0; k < spec.invoicesPln; k++) await draft("invoice", "PLN", true);
  for (let k = 0; k < spec.drafts; k++) await draft("invoice", "EUR", false);
  if (spec.creditNotes) {
    await draft("proforma", "EUR", true);
    await draft("delivery_note", "EUR", true);
    // A full credit note of the first invoice and a partial one (one unit of the first line) of
    // the second; both issued, so the invoice pages list them and the dashboard nets them.
    const full = await createCreditNoteDraft(db, actor, companyId, invoices[0]!.id, "full", {
      issueDate: addDays(invoices[0]!.draft.issueDate, 5),
    });
    await issueDocument(db, actor, companyId, full.id, full.version);
    const second = await getDocument(db, actor, companyId, invoices[1]!.id);
    const partial = await createCreditNoteDraft(
      db,
      actor,
      companyId,
      second.id,
      [{ sourceLineId: second.draft.lines[0]!.id, quantity: "1" }],
      { issueDate: addDays(second.draft.issueDate, 5) },
    );
    await issueDocument(db, actor, companyId, partial.id, partial.version);
    count += 2;
  }
  return count;
}
