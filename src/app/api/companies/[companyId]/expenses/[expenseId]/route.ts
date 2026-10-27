import { headers } from "next/headers";
import { z } from "zod";
import { deleteExpense, getExpense, updateExpense } from "@/modules/finance/server/expense-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; expenseId: string }> };
const pathSchema = z.object({ companyId: z.uuid(), expenseId: z.uuid() });

export async function GET(_request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const { companyId, expenseId } = path.data;
    return ok({ expense: await getExpense(db, toActor(user), companyId, expenseId) });
  } catch (err) {
    return apiError(err);
  }
}

/** Replaces an expense's fields (finance.manage, `expectedVersion`) → `{ expense }`. */
export async function PUT(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const { companyId, expenseId } = path.data;
    return ok({ expense: await updateExpense(db, toActor(user), companyId, expenseId, body) });
  } catch (err) {
    return invalidBody(err);
  }
}

/** Deletes an expense (finance.manage) → `{ deleted: true }`. */
export async function DELETE(_request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    await deleteExpense(db, toActor(user), path.data.companyId, path.data.expenseId);
    return ok({ deleted: true });
  } catch (err) {
    return apiError(err);
  }
}
