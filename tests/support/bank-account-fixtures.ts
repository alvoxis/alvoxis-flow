import { createBankAccount } from "@/modules/documents/server/bank-account-service";
import { type Actor } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";

/** Synthetic account (valid IBAN checksum, fictitious bank) — the same details as invoiceDraft. */
export const FIXTURE_BANK_ACCOUNT = {
  bankName: "Example Bank AS",
  iban: "LV80BANK0000435195001",
  bic: "EXAMLV2X",
} as const;

/** A second synthetic account (valid checksum) for switching accounts in tests. */
export const FIXTURE_BANK_ACCOUNT_2 = {
  bankName: "Sample Credit Union",
  iban: "LT121000011101001000",
  bic: "SAMPLT2X",
} as const;

/** Adds the fixture account as the company default (needs company.manage) and returns its id. */
export async function addFixtureBankAccount(
  db: Database,
  actor: Actor,
  companyId: string,
  account: object = FIXTURE_BANK_ACCOUNT,
): Promise<string> {
  return (await createBankAccount(db, actor, companyId, { isDefault: true, ...account })).id;
}
