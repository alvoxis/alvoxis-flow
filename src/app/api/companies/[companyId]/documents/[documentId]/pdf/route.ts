import { headers } from "next/headers";
import { z } from "zod";
import { getDocumentPdf } from "@/modules/documents/server/pdf-service";
import { getAuth } from "@/server/auth/instance";
import { requireUser, toActor } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { apiError, ok } from "@/server/http/api-errors";

export const dynamic = "force-dynamic";
// PDF rendering (fonts from disk) needs the Node.js runtime.
export const runtime = "nodejs";

type Params = { params: Promise<{ companyId: string; documentId: string }> };

const pathSchema = z.object({ companyId: z.uuid(), documentId: z.uuid() });

/**
 * PDF of one document (documents.view): issued documents from their frozen snapshot, drafts with
 * a "not issued" watermark. `?download=1` asks the browser to save the file instead of showing
 * it. Errors are the usual JSON answers (403 for no access, identical whether or not the company
 * exists; 404 for an unknown document in this company).
 */
export async function GET(request: Request, { params }: Params) {
  const path = pathSchema.safeParse(await params);
  if (!path.success) return ok({ error: "invalid_request" }, 400);
  try {
    const db = getDb();
    const user = await requireUser(getAuth(), db, await headers());
    const { companyId, documentId } = path.data;
    const { bytes, filename } = await getDocumentPdf(db, toActor(user), companyId, documentId);
    const download = new URL(request.url).searchParams.get("download") === "1";
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
        "Content-Length": String(bytes.length),
        // Company data: never stored by shared caches or the browser cache.
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return apiError(err);
  }
}
