import { headers } from "next/headers";
import { z } from "zod";
import { sendDocumentEmail } from "@/modules/documents/server/email-service";
import { getAuth, getMailer } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";
// PDF rendering (fonts from disk) needs the Node.js runtime.
export const runtime = "nodejs";

type Params = { params: Promise<{ companyId: string; documentId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), documentId: z.uuid() });

/**
 * Emails an issued document's PDF (documents.create): `{ to, message? }`. Invalid → 422; a draft →
 * 409 invalid_state document.notIssued; email not configured → email.notConfigured; more than the
 * hourly limit → email.rateLimited. Answers `{ delivery: "sent" | "failed" }`.
 */
export async function POST(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const { companyId, documentId } = path.data;
    return ok(await sendDocumentEmail(db, getMailer(), toActor(user), companyId, documentId, body));
  } catch (err) {
    return invalidBody(err);
  }
}
