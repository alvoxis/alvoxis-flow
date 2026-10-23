import { headers } from "next/headers";
import { z } from "zod";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, ok } from "@/server/http/api-errors";
import { listMembers } from "@/server/tenancy/members-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/** Members with their roles, and the company's roles (members.view). */
export async function GET(_request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    return ok(await listMembers(db, toActor(user), id.data));
  } catch (err) {
    return apiError(err);
  }
}
