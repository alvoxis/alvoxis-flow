import { headers } from "next/headers";
import { z } from "zod";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import {
  changePayrollRun,
  deletePayrollRun,
  getPayrollRun,
} from "@/modules/payroll/server/payroll-service";
import { apiError, invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; runId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), runId: z.uuid() });

/** One run with its lines (payroll.view). */
export async function GET(_request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    return ok({
      run: await getPayrollRun(db, toActor(user), path.data.companyId, path.data.runId),
    });
  } catch (err) {
    return apiError(err);
  }
}

/**
 * Changes a draft run (payroll.manage): `{ action: "recalculate" | "approve", expectedVersion }`
 * or `{ action: "setGross", expectedVersion, employeeId, gross }`. Approved → 409.
 */
export async function PATCH(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const { companyId, runId } = path.data;
    return ok({ run: await changePayrollRun(db, toActor(user), companyId, runId, body) });
  } catch (err) {
    return invalidBody(err);
  }
}

/** Deletes a draft run (payroll.manage): `?expectedVersion=n`. Approved → 409. */
export async function DELETE(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  const version = z.coerce
    .number()
    .int()
    .positive()
    .safeParse(new URL(request.url).searchParams.get("expectedVersion"));
  if (!path.success || !version.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const { companyId, runId } = path.data;
    await deletePayrollRun(db, toActor(user), companyId, runId, version.data);
    return ok({ deleted: true });
  } catch (err) {
    return apiError(err);
  }
}
