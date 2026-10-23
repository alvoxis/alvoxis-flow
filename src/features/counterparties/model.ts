import { orNull } from "@/features/records/api";
import { type PartySnapshot } from "@/modules/documents/domain/types";

/** A customer or supplier as the counterparties API returns it. */
export interface CounterpartyItem {
  id: string;
  isCustomer: boolean;
  isSupplier: boolean;
  name: string;
  registrationNumber: string | null;
  vatNumber: string | null;
  email: string | null;
  phone: string | null;
  contactName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string | null;
  paymentTermDays: number | null;
  notes: string | null;
  archived: boolean;
  version: number;
}

export type CounterpartyKind = "customer" | "supplier";

/** Text fields of the form, as typed. */
export const TEXT_FIELDS = [
  "name",
  "registrationNumber",
  "vatNumber",
  "email",
  "phone",
  "contactName",
  "addressLine1",
  "addressLine2",
  "postalCode",
  "city",
  "countryCode",
  "notes",
] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

export type CounterpartyDraft = Record<TextField, string> & {
  paymentTermDays: string;
  isCustomer: boolean;
  isSupplier: boolean;
};

export function emptyCounterparty(kind: CounterpartyKind): CounterpartyDraft {
  return {
    ...(Object.fromEntries(TEXT_FIELDS.map((f) => [f, ""])) as Record<TextField, string>),
    paymentTermDays: "",
    isCustomer: kind === "customer",
    isSupplier: kind === "supplier",
  };
}

/** Form values of an existing record. */
export function draftOf(item: CounterpartyItem): CounterpartyDraft {
  return {
    ...(Object.fromEntries(TEXT_FIELDS.map((f) => [f, item[f] ?? ""])) as Record<
      TextField,
      string
    >),
    paymentTermDays: item.paymentTermDays === null ? "" : String(item.paymentTermDays),
    isCustomer: item.isCustomer,
    isSupplier: item.isSupplier,
  };
}

/**
 * Request body: trimmed values, empty optional fields as null, the payment term as a number
 * (a non-number is sent as is, so the server reports it on the field).
 */
export function toCounterpartyBody(d: CounterpartyDraft) {
  const term = d.paymentTermDays.trim();
  return {
    ...Object.fromEntries(TEXT_FIELDS.map((f) => [f, f === "name" ? d.name.trim() : orNull(d[f])])),
    paymentTermDays: term === "" ? null : /^\d+$/.test(term) ? Number(term) : -1,
    isCustomer: d.isCustomer,
    isSupplier: d.isSupplier,
  };
}

/** One line of the address for lists: street, postal code and city, country. */
export function addressLine(c: CounterpartyItem): string {
  return [c.addressLine1, [c.postalCode, c.city].filter(Boolean).join(" "), c.countryCode]
    .filter(Boolean)
    .join(", ");
}

/** The buyer details a document gets when a customer is chosen in the editor (empty fields left out). */
export function buyerFromCounterparty(c: CounterpartyItem): PartySnapshot {
  const lines = [c.addressLine1, c.addressLine2].filter((l): l is string => Boolean(l));
  const address =
    lines.length || c.postalCode || c.city || c.countryCode
      ? {
          lines,
          ...(c.postalCode ? { postalCode: c.postalCode } : {}),
          ...(c.city ? { city: c.city } : {}),
          ...(c.countryCode ? { countryCode: c.countryCode } : {}),
        }
      : undefined;
  return {
    name: c.name,
    ...(c.registrationNumber ? { registrationNumber: c.registrationNumber } : {}),
    ...(c.vatNumber ? { vatNumber: c.vatNumber } : {}),
    ...(address ? { address } : {}),
    ...(c.email ? { email: c.email } : {}),
    ...(c.phone ? { phone: c.phone } : {}),
    ...(c.contactName ? { contactName: c.contactName } : {}),
  };
}

/** `issueDate` (YYYY-MM-DD) plus `days`, as YYYY-MM-DD (calendar days, UTC). */
export function addDays(issueDate: string, days: number): string {
  const d = new Date(`${issueDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
