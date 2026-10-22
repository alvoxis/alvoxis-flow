"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { ForbiddenError, TwoFactorRequiredError, UnauthenticatedError } from "@/server/errors";
import { updateCompanyProfile } from "@/server/tenancy/company-profile";

export type CompanyProfileFormState =
  | null
  | { status: "saved" }
  | { status: "invalid"; fields: string[] }
  | { status: "forbidden" | "two_factor_required" | "error" };

const FIELDS = [
  "name",
  "legalName",
  "registrationNumber",
  "vatNumber",
  "addressLine1",
  "addressLine2",
  "postalCode",
  "city",
] as const;

/** Saves the profile form; the server re-checks access (company.manage) on every call. */
export async function saveCompanyProfileAction(
  _prev: CompanyProfileFormState,
  formData: FormData,
): Promise<CompanyProfileFormState> {
  const companyId = z.uuid().safeParse(formData.get("companyId"));
  const locale = z.enum(["en", "ru", "lv", "lt", "et"]).safeParse(formData.get("locale"));
  if (!companyId.success || !locale.success) return { status: "error" };
  const input: Record<string, unknown> = Object.fromEntries(
    FIELDS.map((f) => [f, typeof formData.get(f) === "string" ? formData.get(f) : ""]),
  );
  // Optional: only sent by forms that show the PDF colour choice; validated against the palette.
  const pdfAccent = formData.get("pdfAccent");
  if (typeof pdfAccent === "string") input.pdfAccent = pdfAccent;
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const result = await updateCompanyProfile(db, toActor(user), companyId.data, input);
    if (!result.ok) return { status: "invalid", fields: Object.keys(result.fieldErrors) };
    revalidatePath(`/${locale.data}/companies/${companyId.data}/profile`);
    revalidatePath(`/${locale.data}`);
    return { status: "saved" };
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) return { status: "two_factor_required" };
    if (err instanceof ForbiddenError || err instanceof UnauthenticatedError)
      return { status: "forbidden" };
    throw err;
  }
}
