import { headers } from "next/headers";
import { z } from "zod";
import { importDecisionsSchema } from "@/modules/documents/import/decisions-schema";
import { createDraftFromImport } from "@/modules/documents/server/import-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { invalidBody, ok } from "@/server/http/api-errors";
import { readPdfUpload } from "@/server/http/pdf-upload";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ companyId: string }> };

/**
 * Creates a DRAFT from a reviewed PDF import (documents.create): multipart `file` + `decisions`
 * (JSON). The server reads the file again, so the review cannot be tampered with; every finding
 * must be acknowledged (422 otherwise). The file is not stored.
 */
export async function POST(request: Request, { params }: Params) {
  const id = z.uuid().safeParse((await params).companyId);
  if (!id.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const upload = await readPdfUpload(request);
    if (!upload.ok) return upload.response;
    const raw = upload.form.get("decisions");
    let json: unknown = null;
    try {
      json = typeof raw === "string" ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    if (json === null || typeof json !== "object") return ok({ error: "invalid_request" }, 400);
    const decisions = importDecisionsSchema.parse(json);
    const document = await createDraftFromImport(
      db,
      toActor(user),
      id.data,
      upload.bytes,
      decisions,
    );
    return ok({ document }, 201);
  } catch (err) {
    return invalidBody(err);
  }
}
