import { eq } from "drizzle-orm";
import { z } from "zod";
import { PDF_ACCENTS, type PdfAccent } from "@/lib/pdf-accent";
import { recordAudit } from "@/server/audit/audit-log";
import { type Actor, requireCompanyAccess } from "@/server/auth/authorization";
import { type Database } from "@/server/db/client";
import { companies } from "@/server/db/schema";
import { type CountryCode } from "./company-service";

/**
 * Company profile: the company's own identification details (later used as the seller on
 * documents). Validation is about format only — it does not check registries and makes no
 * claim that a number is legally valid or registered.
 */
export interface CompanyProfile {
  id: string;
  name: string;
  legalName: string | null;
  /** Fixed at creation (document numbering and defaults depend on it); not editable here. */
  country: CountryCode;
  registrationNumber: string | null;
  vatNumber: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  /** Accent colour of the company's document PDFs (fixed palette; presentation only). */
  pdfAccent: PdfAccent;
  updatedAt: Date;
}

/** Empty strings mean "not set"; surrounding and repeated whitespace is collapsed. */
const optionalText = (max: number) =>
  z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, " "))
    .pipe(z.string().max(max))
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const profileFields = z.object({
  name: z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, " "))
    .pipe(z.string().min(1).max(200)),
  legalName: optionalText(300),
  registrationNumber: optionalText(32).refine(
    (v) => v == null || /^[\p{L}\p{N}][\p{L}\p{N} ./-]*$/u.test(v),
    { message: "registrationNumber.format" },
  ),
  vatNumber: optionalText(20).transform((v) =>
    v == null ? v : v.replace(/[\s.-]/g, "").toUpperCase(),
  ),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  postalCode: optionalText(16),
  city: optionalText(100),
  pdfAccent: z.enum(PDF_ACCENTS).optional(),
});

export type CompanyProfileInput = z.input<typeof profileFields>;

/**
 * Validates profile input for a company in `country`. An EU VAT identification number starts
 * with the member state's code (LV, LT, EE, PL) followed by 2–12 letters or digits; nothing
 * more specific is checked.
 */
export function parseCompanyProfile(input: unknown, country: CountryCode) {
  return profileFields
    .superRefine((v, ctx) => {
      if (v.vatNumber != null && !new RegExp(`^${country}[A-Z0-9]{2,12}$`).test(v.vatNumber)) {
        ctx.addIssue({ code: "custom", path: ["vatNumber"], message: "vatNumber.format" });
      }
    })
    .safeParse(input);
}

const profileColumns = {
  id: companies.id,
  name: companies.name,
  legalName: companies.legalName,
  country: companies.country,
  registrationNumber: companies.registrationNumber,
  vatNumber: companies.vatNumber,
  addressLine1: companies.addressLine1,
  addressLine2: companies.addressLine2,
  postalCode: companies.postalCode,
  city: companies.city,
  pdfAccent: companies.pdfAccent,
  updatedAt: companies.updatedAt,
};

export interface CompanyProfileView {
  profile: CompanyProfile;
  /** Whether the actor may change it (`company.manage`); the server re-checks on update. */
  canEdit: boolean;
}

export async function getCompanyProfile(
  db: Database,
  actor: Actor,
  companyId: string,
): Promise<CompanyProfileView> {
  const ctx = await requireCompanyAccess(db, actor, companyId, "company.view");
  const [profile] = await db
    .select(profileColumns)
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  return { profile: profile!, canEdit: ctx.permissions.has("company.manage") };
}

export type UpdateCompanyProfileResult =
  { ok: true; profile: CompanyProfile } | { ok: false; fieldErrors: Record<string, string[]> };

/** Updates the profile; requires `company.manage` and records which fields changed. */
export async function updateCompanyProfile(
  db: Database,
  actor: Actor,
  companyId: string,
  input: unknown,
): Promise<UpdateCompanyProfileResult> {
  const ctx = await requireCompanyAccess(db, actor, companyId, "company.manage");
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select(profileColumns)
      .from(companies)
      .where(eq(companies.id, ctx.companyId))
      .for("update");
    const parsed = parseCompanyProfile(input, current!.country);
    if (!parsed.success) {
      return { ok: false as const, fieldErrors: z.flattenError(parsed.error).fieldErrors };
    }
    const next = parsed.data;
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
      (key) => next[key] !== undefined && (next[key] ?? null) !== current![key],
    );
    if (changed.length === 0) return { ok: true as const, profile: current! };

    const [profile] = await tx
      .update(companies)
      .set(Object.fromEntries(changed.map((key) => [key, next[key] ?? null])))
      .where(eq(companies.id, ctx.companyId))
      .returning(profileColumns);
    // Field names only: the values are business data and stay in the companies table.
    await recordAudit(tx, {
      companyId: ctx.companyId,
      actorUserId: actor.userId,
      action: "company.profile_updated",
      entityType: "company",
      entityId: ctx.companyId,
      metadata: { changed },
    });
    return { ok: true as const, profile: profile! };
  });
}
