import { headers } from "next/headers";
import { z } from "zod";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { getPayrollRates, setPayrollRates } from "@/modules/payroll/server/payroll-service";
import { apiError, invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/** Payroll rates per country, saved or default (payroll.view). */
export async function GET(_request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    return ok({ rates: await getPayrollRates(db, toActor(user), id.data) });
  } catch (err) {
    return apiError(err);
  }
}

/**
 * Saves one country's rates (payroll.manage): `{ country, expectedVersion (0 for defaults),
 * employeeSocialRate, employerSocialRate, incomeTaxRate, employeeHealthRate }` in percent.
 */
export async function PUT(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    return ok({ rates: await setPayrollRates(db, toActor(user), id.data, body) });
  } catch (err) {
    return invalidBody(err);
  }
}
