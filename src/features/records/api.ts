import { type ApiIssue } from "@/features/documents/editor-model";

/**
 * Client-side glue shared by the company record pages (customers and suppliers, products,
 * inventory, production, payroll): one way to send a request and classify the answer by its
 * documented status and error code. No rules here; the server decides.
 */
export type RecordOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "invalid"; issues: ApiIssue[] }
  | { kind: "taken"; code: string }
  | { kind: "state"; code: string }
  | { kind: "conflict" }
  | { kind: "signedOut" }
  | { kind: "twoFactor" }
  | { kind: "forbidden" }
  | { kind: "notFound" }
  | { kind: "error" };

/** Classifies a response whose success body is `{ [key]: T }`. */
export function interpretRecordResponse<T>(
  status: number,
  body: unknown,
  key: string,
): RecordOutcome<T> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (status >= 200 && status < 300 && key in b) return { kind: "ok", value: b[key] as T };
  if (status === 422 && b.error === "validation_failed" && Array.isArray(b.issues))
    return { kind: "invalid", issues: b.issues as ApiIssue[] };
  if (status === 409 && b.error === "version_conflict") return { kind: "conflict" };
  if (status === 409 && b.error === "invalid_state")
    return { kind: "state", code: typeof b.code === "string" ? b.code : "" };
  if (status === 409 && typeof b.error === "string") return { kind: "taken", code: b.error };
  if (status === 401 && b.error === "two_factor_challenge_required") return { kind: "twoFactor" };
  if (status === 401) return { kind: "signedOut" };
  if (status === 403 && b.error === "two_factor_enrollment_required") return { kind: "twoFactor" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "notFound" };
  return { kind: "error" };
}

/** Sends JSON and classifies the answer; network failures are `error`. */
export async function sendRecord<T>(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
  key: string,
): Promise<RecordOutcome<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return interpretRecordResponse<T>(res.status, await res.json().catch(() => null), key);
  } catch {
    return { kind: "error" };
  }
}

/** Which form field an issue points at (first path segment). */
export function fieldOfIssue(path: string): string {
  return path.split(/[.[]/)[0] ?? "";
}

/** Trimmed text, or null when empty (for optional fields in request bodies). */
export const orNull = (v: string) => (v.trim() ? v.trim() : null);
