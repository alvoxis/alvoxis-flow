import { headers } from "next/headers";
import { z } from "zod";
import { issueDocument } from "@/modules/documents/server/document-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; documentId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), documentId: z.uuid() });
const issueSchema = z.object({ expectedVersion: z.number().int().positive() });

/**
 * Issues a draft (documents.approve): `{ expectedVersion }`. Validation, numbering, the frozen
 * snapshot and the audit entry happen in one transaction, so a failed issue uses no number.
 * Blocking findings → 422; already issued or stale version → 409 (no new number).
 */
export async function POST(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const { expectedVersion } = issueSchema.parse(body);
    const { companyId, documentId } = path.data;
    return ok({
      document: await issueDocument(db, toActor(user), companyId, documentId, expectedVersion),
    });
  } catch (err) {
    return invalidBody(err);
  }
}
