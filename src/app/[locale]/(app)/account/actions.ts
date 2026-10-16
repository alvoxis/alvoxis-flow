"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { insertDefaultNumberSeries } from "@/modules/documents/server/numbering-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { revokeMyOtherSessions, revokeMySession } from "@/server/auth/sessions-service";
import { getDb } from "@/server/db/client";
import { createCompanyWithOwner } from "@/server/tenancy/company-service";

const localeSchema = z.enum(["en", "ru", "lv", "lt", "et"]);

async function currentUser() {
  return requireUser(getAuth(), getDb(), await headers());
}

/** Signs out one of the caller's own sessions (ownership is checked in the query). */
export async function revokeSessionAction(formData: FormData) {
  const user = await currentUser();
  const sessionId = z.uuid().parse(formData.get("sessionId"));
  const locale = localeSchema.parse(formData.get("locale"));
  await revokeMySession(getDb(), user, sessionId);
  if (sessionId === user.sessionId) redirect(`/${locale}/sign-in`);
  revalidatePath(`/${locale}/account/security`);
}

export async function revokeOtherSessionsAction(formData: FormData) {
  const user = await currentUser();
  const locale = localeSchema.parse(formData.get("locale"));
  await revokeMyOtherSessions(getDb(), user);
  revalidatePath(`/${locale}/account/security`);
}

const companySchema = z.object({
  name: z.string().trim().min(1).max(200),
  country: z.enum(["LV", "LT", "EE", "PL"]),
  locale: localeSchema,
});

export async function createCompanyAction(_prev: { error?: string } | null, formData: FormData) {
  const user = await currentUser();
  const parsed = companySchema.safeParse({
    name: formData.get("name"),
    country: formData.get("country"),
    locale: formData.get("locale"),
  });
  if (!parsed.success) return { error: "invalid" };
  const db = getDb();
  const { companyId } = await createCompanyWithOwner(db, toActor(user), {
    name: parsed.data.name,
    country: parsed.data.country,
  });
  await insertDefaultNumberSeries(db, companyId);
  revalidatePath(`/${parsed.data.locale}`);
  return { error: undefined };
}
