import { type ApiIssue } from "@/features/documents/editor-model";

/**
 * Client-side glue for the company bank-accounts page and the document account pickers. No
 * rules here: IBAN/BIC checks, permissions and uniqueness are decided by the server.
 */

/** An account as the bank-accounts API returns it. */
export interface BankAccountItem {
  id: string;
  label: string | null;
  bankName: string | null;
  iban: string;
  bic: string | null;
  isDefault: boolean;
  archived: boolean;
  version: number;
}

export type BankAccountOutcome =
  | { kind: "ok"; bankAccount: BankAccountItem }
  | { kind: "invalid"; issues: ApiIssue[] }
  | { kind: "ibanTaken" }
  | { kind: "conflict" }
  | { kind: "signedOut" }
  | { kind: "twoFactor" }
  | { kind: "forbidden" }
  | { kind: "notFound" }
  | { kind: "error" };

/** Classifies a bank-accounts API response by its documented status and error code. */
export function interpretBankAccountResponse(status: number, body: unknown): BankAccountOutcome {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (status >= 200 && status < 300 && b.bankAccount && typeof b.bankAccount === "object")
    return { kind: "ok", bankAccount: b.bankAccount as BankAccountItem };
  if (status === 422 && b.error === "validation_failed" && Array.isArray(b.issues))
    return { kind: "invalid", issues: b.issues as ApiIssue[] };
  if (status === 409 && b.error === "iban_taken") return { kind: "ibanTaken" };
  if (status === 409 && b.error === "version_conflict") return { kind: "conflict" };
  if (status === 401 && b.error === "two_factor_challenge_required") return { kind: "twoFactor" };
  if (status === 401) return { kind: "signedOut" };
  if (status === 403 && b.error === "two_factor_enrollment_required") return { kind: "twoFactor" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "notFound" };
  return { kind: "error" };
}

/** Form fields of a new account (strings as typed; the server normalizes and validates). */
export interface BankAccountDraft {
  label: string;
  bankName: string;
  iban: string;
  bic: string;
  isDefault: boolean;
}

export const EMPTY_BANK_ACCOUNT: BankAccountDraft = {
  label: "",
  bankName: "",
  iban: "",
  bic: "",
  isDefault: false,
};

/** POST body: trimmed values, empty optional fields omitted. */
export function toCreateBankAccountBody(d: BankAccountDraft) {
  const opt = (v: string) => (v.trim() ? v.trim() : undefined);
  return {
    iban: d.iban.trim(),
    ...(opt(d.label) ? { label: opt(d.label) } : {}),
    ...(opt(d.bankName) ? { bankName: opt(d.bankName) } : {}),
    ...(opt(d.bic) ? { bic: opt(d.bic) } : {}),
    ...(d.isDefault ? { isDefault: true } : {}),
  };
}

/** `LV80BANK0000435195001` → `LV80 BANK 0000 4351 9500 1` (display only). */
export function formatIban(iban: string): string {
  return iban.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");
}

/** Short name of an account for pickers: label, else bank name, plus the formatted IBAN. */
export function accountName(a: Pick<BankAccountItem, "label" | "bankName" | "iban">): string {
  const name = a.label || a.bankName;
  return name ? `${name} · ${formatIban(a.iban)}` : formatIban(a.iban);
}

/** Which form field an issue points at (`iban`, `bic`, `label`, `bankName`, or ""). */
export function fieldOfIssue(path: string): string {
  return path.split(".")[0] ?? "";
}
