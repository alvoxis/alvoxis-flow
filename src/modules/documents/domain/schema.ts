import { z } from "zod";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import { LOCALES } from "@/i18n/config";
import { DOCUMENT_TYPES, TAX_TREATMENT_KINDS, type DocumentDraft } from "./types";

/**
 * Shape validation for untrusted draft input (API / forms / import review). Business rules are
 * checked separately by `validateDocument`, which returns translatable issues instead of throwing.
 */
const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).optional();
const decimalString = z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/, "Expected a decimal string");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const address = z.object({
  lines: z.array(text(200)).max(4),
  postalCode: optText(20),
  city: optText(100),
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
});

const party = z.object({
  name: text(300),
  registrationNumber: optText(50),
  vatNumber: optText(50),
  address: address.optional(),
  legalAddress: address.optional(),
  email: z.email().max(254).optional(),
  phone: optText(50),
  contactName: optText(200),
});

/** A new company tax category (`code`, `kind` and `ratePercent` cannot change later). */
export const taxCategoryCreateSchema = z.strictObject({
  code: text(30).min(1),
  kind: z.enum(TAX_TREATMENT_KINDS),
  ratePercent: decimalString,
  label: text(100).min(1),
  note: optText(1000),
});

/** Editable fields of a company tax category, with optimistic locking. */
export const taxCategoryUpdateSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  label: text(100).min(1).optional(),
  note: text(1000).nullable().optional(),
  archived: z.boolean().optional(),
});

const lineInput = z.object({
  id: z.string().max(64).optional(),
  kind: z.enum(["item", "charge"]).default("item"),
  description: text(1000),
  quantity: decimalString,
  unit: optText(20),
  unitPrice: decimalString.nullable(),
  discountPercent: decimalString.optional(),
  /**
   * A category from the company catalog; the server builds the snapshot. Inline category objects
   * are refused so a client cannot submit a category the company has not defined.
   */
  taxCategoryId: z.uuid().nullable().default(null),
  taxCategory: z.never().optional(),
  weightKg: decimalString.optional(),
});

const exchangeRate = z.object({
  from: z.enum(SUPPORTED_CURRENCIES),
  to: z.enum(SUPPORTED_CURRENCIES),
  rate: z.string().regex(/^\d{1,8}(\.\d{1,10})?$/),
  rateDate: isoDate,
  source: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("reference"),
      provider: text(100).min(1),
      retrievedAt: z.string().max(40),
    }),
    z.object({
      kind: z.literal("manual"),
      enteredByUserId: z.string().max(64),
      reason: optText(500),
    }),
  ]),
});

export const draftInputSchema = z.object({
  type: z.enum(DOCUMENT_TYPES),
  language: z.enum(LOCALES),
  currency: z.enum(SUPPORTED_CURRENCIES),
  issueDate: isoDate,
  dueDate: isoDate.optional(),
  supplyDate: isoDate.optional(),
  validUntil: isoDate.optional(),
  seller: party,
  buyer: party,
  deliverTo: party.optional(),
  /**
   * A company bank account (by id); the server builds the printed details from it. Omitted on
   * update = keep the current choice; null = no bank account. Inline account details are refused
   * so a client cannot put an arbitrary IBAN on a document.
   */
  bankAccountId: z.uuid().nullable().optional(),
  bankAccounts: z.never().optional(),
  buyerReference: optText(200),
  paymentTerms: optText(500),
  notes: optText(2000),
  footer: optText(1000),
  lines: z.array(lineInput).max(500),
  exchangeRate: exchangeRate.optional(),
});

export type DraftInput = z.input<typeof draftInputSchema>;

/**
 * Parses untrusted input into a DocumentDraft (relations are never accepted from input). Lines
 * carry only `taxCategoryId`; the server resolves it against the company catalog and fills in
 * the snapshot (`taxCategory` is null until then).
 */
export function parseDraftInput(input: unknown, newLineId: () => string): DocumentDraft {
  const { bankAccountId: _bank, bankAccounts: _never, ...parsed } = draftInputSchema.parse(input);
  return {
    ...parsed,
    bankAccounts: [],
    lines: parsed.lines.map(({ taxCategoryId, taxCategory: _never, ...l }) => ({
      ...l,
      id: newLineId(),
      taxCategory: null,
      ...(taxCategoryId ? { taxCategoryId } : {}),
    })),
  };
}
