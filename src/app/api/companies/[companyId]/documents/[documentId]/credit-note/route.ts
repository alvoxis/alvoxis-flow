import { headers } from "next/headers";
import { z } from "zod";
import { LOCALES } from "@/i18n/config";
import { createCreditNoteDraft } from "@/modules/documents/server/document-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { invalidBody, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string; documentId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), documentId: z.uuid() });

// Strict: unknown fields (e.g. a unit price) are refused rather than silently ignored, so a client
// never credits more than it meant to.
const creditNoteSchema = z
  .object({
    issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    language: z.enum(LOCALES).optional(),
    lines: z.union([
      z.literal("full"),
      z
        .array(
          z
            .object({
              sourceLineId: z.string().min(1).max(64),
              quantity: z.string().regex(/^\d{1,14}(\.\d{1,6})?$/),
            })
            .strict(),
        )
        .min(1)
        .max(500),
    ]),
  })
  .strict();

/**
 * Creates a credit-note DRAFT for an issued invoice (documents.create):
 * `{ issueDate, language?, lines: "full" | [{ sourceLineId, quantity }] }`. Remaining quantities
 * and amounts take issued credit notes into account; the invoice itself is never changed. The
 * draft is issued through `…/issue` (documents.approve), which allocates its number.
 */
export async function POST(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const body: unknown = await request.json().catch(() => null);
    if (body === null || typeof body !== "object") return ok({ error: "invalid_request" }, 400);
    const { issueDate, language, lines } = creditNoteSchema.parse(body);
    const { companyId, documentId } = path.data;
    const document = await createCreditNoteDraft(db, toActor(user), companyId, documentId, lines, {
      issueDate,
      language,
    });
    return ok({ document }, 201);
  } catch (err) {
    return invalidBody(err);
  }
}
