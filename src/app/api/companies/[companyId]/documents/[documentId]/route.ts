import { headers } from "next/headers";
import { z } from "zod";
import { deleteDraft, getDocument, updateDraft } from "@/modules/documents/server/document-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; documentId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), documentId: z.uuid() });
const patchSchema = z.object({ expectedVersion: z.number().int().positive(), draft: z.unknown() });

/** One document (documents.view). Issued documents are served from their frozen snapshot. */
export async function GET(_request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const { companyId, documentId } = path.data;
    return ok({ document: await getDocument(db, toActor(user), companyId, documentId) });
  } catch (err) {
    return apiError(err);
  }
}

/**
 * Replaces a draft's content (documents.create): `{ expectedVersion, draft }`. A stale version or
 * an issued document → 409; invalid input → 422.
 */
export async function PATCH(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const { expectedVersion, draft } = patchSchema.parse(body);
    const { companyId, documentId } = path.data;
    const document = await updateDraft(
      db,
      toActor(user),
      companyId,
      documentId,
      expectedVersion,
      draft,
    );
    return ok({ document });
  } catch (err) {
    return invalidBody(err);
  }
}

/** Deletes a draft (documents.create); issued documents cannot be deleted (409). */
export async function DELETE(_request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    await deleteDraft(db, toActor(user), path.data.companyId, path.data.documentId);
    return ok({ deleted: true });
  } catch (err) {
    return apiError(err);
  }
}
