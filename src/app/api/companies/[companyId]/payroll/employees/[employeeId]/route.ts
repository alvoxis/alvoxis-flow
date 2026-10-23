import { headers } from "next/headers";
import { z } from "zod";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { updateEmployee } from "@/modules/payroll/server/payroll-service";
import { invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; employeeId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), employeeId: z.uuid() });

/** Edits, archives or restores an employee (payroll.manage): `{ expectedVersion, … }`. */
export async function PATCH(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const { companyId, employeeId } = path.data;
    return ok({ employee: await updateEmployee(db, toActor(user), companyId, employeeId, body) });
  } catch (err) {
    return invalidBody(err);
  }
}
