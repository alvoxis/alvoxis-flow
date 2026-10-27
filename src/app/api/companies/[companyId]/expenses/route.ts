import { headers } from "next/headers";
import { z } from "zod";
import { createExpense, searchExpenses } from "@/modules/finance/server/expense-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/**
 * One page of expenses (finance.view): `?q&category&status&from&to&sort&page` →
 * `{ expenses, total, page, pageSize }`. Unknown filter values → 422.
 */
export async function GET(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const query = Object.fromEntries(new URL(request.url).searchParams);
    return ok(await searchExpenses(db, toActor(user), id.data, query));
  } catch (err) {
    return invalidBody(err);
  }
}

/** Adds an expense (finance.manage) → 201 `{ expense }`. */
export async function POST(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    return ok({ expense: await createExpense(db, toActor(user), id.data, body) }, 201);
  } catch (err) {
    return invalidBody(err);
  }
}
