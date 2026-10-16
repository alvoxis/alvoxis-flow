import { headers } from "next/headers";
import { z } from "zod";
import { listDocuments } from "@/modules/documents/server/document-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

/** Company-scoped data: session → actor → requireCompanyAccess (inside listDocuments). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ companyId: string }> },
) {
  try {
    const { companyId } = await params;
    const id = z.uuid().parse(companyId);
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    return ok({ documents: await listDocuments(db, toActor(user), id) });
  } catch (err) {
    return apiError(err);
  }
}
