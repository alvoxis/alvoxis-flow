import { type AppLocale } from "@/i18n/config";

/**
 * Client-side glue for creating a credit note from an issued invoice through
 * `POST …/documents/{invoiceId}/credit-note`. No business rules: what remains to be credited, the
 * date rule, the source kind, access and numbering are all decided on the server (the API answers
 * with `creditNote.*` issue codes). The checks below only catch obvious form mistakes early.
 */

/** Matches the domain limit for line quantities (`LIMITS.quantityDecimals`, see the unit test). */
export const CREDIT_QUANTITY_DECIMALS = 4;

/** The invoice line data the dialog shows: what was invoiced, never what remains (variant A). */
export interface CreditableLine {
  id: string;
  description: string;
  /** Invoiced quantity as stored (positive decimal string). */
  quantity: string;
  unit?: string;
}

export interface CreditNoteForm {
  mode: "full" | "partial";
  issueDate: string;
  language: AppLocale;
  /** Partial mode: quantity to credit per invoice line id, as typed ("" = not credited). */
  quantities: Record<string, string>;
}

/** A form mistake caught before the request; `lineId` points at a partial-mode quantity field. */
export interface CreditFormError {
  code: "dateRequired" | "dateBeforeInvoice" | "noLines" | "quantityInvalid" | "quantityTooHigh";
  lineId?: string;
}

/** Accepts a decimal comma (lv/lt/et/ru keyboards) and surrounding spaces. */
export function normalizeQuantity(raw: string): string {
  return raw.trim().replace(",", ".");
}

const QUANTITY = new RegExp(`^\\d{1,14}(\\.\\d{1,${CREDIT_QUANTITY_DECIMALS}})?$`);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Scales a non-negative decimal string to an integer of `CREDIT_QUANTITY_DECIMALS` places. */
function scaled(value: string): bigint {
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  return BigInt(
    whole! + fraction.padEnd(CREDIT_QUANTITY_DECIMALS, "0").slice(0, CREDIT_QUANTITY_DECIMALS),
  );
}

/** Form mistakes, in field order; empty when the request may be sent. */
export function creditFormErrors(
  form: CreditNoteForm,
  invoice: { issueDate: string; lines: readonly CreditableLine[] },
): CreditFormError[] {
  const errors: CreditFormError[] = [];
  if (!ISO_DATE.test(form.issueDate)) errors.push({ code: "dateRequired" });
  else if (form.issueDate < invoice.issueDate) errors.push({ code: "dateBeforeInvoice" });
  if (form.mode === "full") return errors;

  let any = false;
  for (const line of invoice.lines) {
    const raw = normalizeQuantity(form.quantities[line.id] ?? "");
    if (raw === "") continue;
    any = true;
    if (!QUANTITY.test(raw) || scaled(raw) === 0n)
      errors.push({ code: "quantityInvalid", lineId: line.id });
    else if (scaled(raw) > scaled(line.quantity))
      errors.push({ code: "quantityTooHigh", lineId: line.id });
  }
  if (!any) errors.push({ code: "noLines" });
  return errors;
}

/** Request body for the credit-note endpoint; partial mode sends only the filled-in lines. */
export function toCreditNoteBody(form: CreditNoteForm, lines: readonly CreditableLine[]) {
  return {
    issueDate: form.issueDate,
    language: form.language,
    lines:
      form.mode === "full"
        ? ("full" as const)
        : lines
            .map((l) => ({
              sourceLineId: l.id,
              quantity: normalizeQuantity(form.quantities[l.id] ?? ""),
            }))
            .filter((l) => l.quantity !== ""),
  };
}

/** The later of today and the invoice date: a credit note cannot predate its invoice. */
export function defaultCreditDate(today: string, invoiceDate: string): string {
  return today > invoiceDate ? today : invoiceDate;
}
