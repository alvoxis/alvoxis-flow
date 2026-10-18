import "server-only";
import { MAX_UPLOAD_BYTES } from "@/features/documents/import-model";
import { ok } from "./api-errors";

/** Room for the multipart envelope and the decisions JSON next to the file. */
const ENVELOPE_BYTES = 256 * 1024;

export type PdfUpload =
  { ok: true; bytes: Uint8Array; form: FormData } | { ok: false; response: Response };

/**
 * Reads one uploaded PDF from a multipart request, in memory only: nothing is written to disk or
 * kept after the request. Refuses an oversized body before reading it (413), and anything other
 * than exactly one `file` field (400). Whether it really is a PDF is checked by the import service.
 */
export async function readPdfUpload(request: Request): Promise<PdfUpload> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_UPLOAD_BYTES + ENVELOPE_BYTES)
    return { ok: false, response: ok({ error: "file_too_large" }, 413) };
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { ok: false, response: ok({ error: "invalid_request" }, 400) };
  }
  const files = form.getAll("file");
  const file = files[0];
  if (files.length !== 1 || !(file instanceof File))
    return { ok: false, response: ok({ error: "invalid_request" }, 400) };
  if (file.size > MAX_UPLOAD_BYTES)
    return { ok: false, response: ok({ error: "file_too_large" }, 413) };
  return { ok: true, bytes: new Uint8Array(await file.arrayBuffer()), form };
}
