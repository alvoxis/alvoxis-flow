import { headers } from "next/headers";
import { z } from "zod";
import { previewPdfImport } from "@/modules/documents/server/import-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, ok } from "@/server/http/api-errors";
import { readPdfUpload } from "@/server/http/pdf-upload";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/**
 * Reads an uploaded PDF and returns the extracted fields for review (documents.create). Creates
 * nothing and stores no file; only the file hash and finding codes are audited.
 */
export async function POST(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    // Authenticate before reading the body, so anonymous uploads are never parsed.
    const user = await requireUser(getAuth(), db, await headers());
    const upload = await readPdfUpload(request);
    if (!upload.ok) return upload.response;
    return ok({ review: await previewPdfImport(db, toActor(user), id.data, upload.bytes) });
  } catch (err) {
    return apiError(err);
  }
}
