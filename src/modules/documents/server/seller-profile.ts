import "server-only";
import { eq } from "drizzle-orm";
import { type DbOrTx } from "@/server/db/client";
import { companies } from "@/server/db/schema";
import { type PartySnapshot } from "../domain/types";

/**
 * The company profile is the source of the seller's identification on documents: legal (or
 * display) name, registration number, VAT number and registered address. The contact fields of
 * a draft (email, phone, contact person) are kept as entered.
 *
 * Callers must already hold an access check for `companyId` (requireCompanyAccess).
 */
export type SellerIdentity = Pick<
  PartySnapshot,
  "name" | "registrationNumber" | "vatNumber" | "address"
>;

export async function loadSellerIdentity(tx: DbOrTx, companyId: string): Promise<SellerIdentity> {
  const [c] = await tx
    .select({
      name: companies.name,
      legalName: companies.legalName,
      country: companies.country,
      registrationNumber: companies.registrationNumber,
      vatNumber: companies.vatNumber,
      addressLine1: companies.addressLine1,
      addressLine2: companies.addressLine2,
      postalCode: companies.postalCode,
      city: companies.city,
    })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!c) throw new Error("Company not found for an authorised request");
  const lines = [c.addressLine1, c.addressLine2].filter((l): l is string => Boolean(l));
  return {
    name: c.legalName ?? c.name,
    ...(c.registrationNumber ? { registrationNumber: c.registrationNumber } : {}),
    ...(c.vatNumber ? { vatNumber: c.vatNumber } : {}),
    // No street line → no address; issuing then stops with "seller.address.required".
    ...(lines.length
      ? {
          address: {
            lines,
            ...(c.postalCode ? { postalCode: c.postalCode } : {}),
            ...(c.city ? { city: c.city } : {}),
            countryCode: c.country,
          },
        }
      : {}),
  };
}

/** Seller = profile identity + the draft's contact fields. Nothing else from the draft is kept. */
export function applySellerIdentity(
  draftSeller: Partial<PartySnapshot> | undefined,
  identity: SellerIdentity,
): PartySnapshot {
  const contact: Partial<PartySnapshot> = {};
  if (draftSeller?.email) contact.email = draftSeller.email;
  if (draftSeller?.phone) contact.phone = draftSeller.phone;
  if (draftSeller?.contactName) contact.contactName = draftSeller.contactName;
  return { ...identity, ...contact };
}

/** Same for untrusted draft input (before parsing): replaces the seller's identity fields. */
export function applySellerIdentityToInput(input: unknown, identity: SellerIdentity): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const raw = (input as { seller?: unknown }).seller;
  const seller = raw && typeof raw === "object" ? (raw as Partial<PartySnapshot>) : undefined;
  return { ...input, seller: applySellerIdentity(seller, identity) };
}
