import { headers } from "next/headers";
import { z } from "zod";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { createEmployee, listEmployees } from "@/modules/payroll/server/payroll-service";
import { apiError, invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/** Employees by name (payroll.view); `includeArchived=1` adds archived ones. */
export async function GET(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const includeArchived = new URL(request.url).searchParams.get("includeArchived") === "1";
    return ok({ employees: await listEmployees(db, toActor(user), id.data, { includeArchived }) });
  } catch (err) {
    return apiError(err);
  }
}

/**
 * Adds an employee (payroll.manage): `{ firstName, lastName, taxCountry, employmentStart,
 * monthlyGross, position?, email?, employmentEnd?, monthlyAllowance?, monthlyTaxCredit? }`.
 */
export async function POST(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    return ok({ employee: await createEmployee(db, toActor(user), id.data, body) }, 201);
  } catch (err) {
    return invalidBody(err);
  }
}
