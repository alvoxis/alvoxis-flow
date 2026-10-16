import { headers } from "next/headers";
import { z } from "zod";
import { createDraft, listDocuments } from "@/modules/documents/server/document-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/** Company-scoped data: session → actor → requireCompanyAccess (inside listDocuments). */
export async function GET(_request: Request, { params }: Params) {
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

/**
 * Creates a draft (documents.create). The body is the draft input; the seller always comes from
 * the company profile. Shape errors → 422; business-rule findings are returned in `issues`.
 */
export async function POST(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    return ok({ document: await createDraft(db, toActor(user), id.data, body) }, 201);
  } catch (err) {
    return invalidBody(err);
  }
}
