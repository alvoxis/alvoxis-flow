import { z } from "zod";
import { LOCALES } from "@/i18n/config";
import { SUPPORTED_CURRENCIES } from "@/lib/money";
import { partyInputSchema } from "../domain/schema";
import { type ImportDecisions } from "./to-draft";

/**
 * Shape check for the review decisions sent with an import (untrusted input). Strict: unknown
 * fields are refused. The business checks (every finding acknowledged, duplicates confirmed, lines
 * complete) stay in `toDraftInput`, and the draft itself is validated by `createDraft`.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimal = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/);
const optText = (max: number) => z.string().trim().max(max).optional();

export const importDecisionsSchema = z.strictObject({
  type: z.enum(["invoice", "proforma", "delivery_note"]),
  language: z.enum(LOCALES),
  currency: z.enum(SUPPORTED_CURRENCIES),
  issueDate: isoDate,
  dueDate: isoDate.optional(),
  seller: partyInputSchema,
  buyer: partyInputSchema,
  bankAccountId: z.uuid().optional(),
  buyerReference: optText(200),
  paymentTerms: optText(500),
  notes: optText(2000),
  defaultTaxCategoryId: z.uuid(),
  lines: z
    .array(
      z.strictObject({
        description: z.string().trim().min(1).max(1000),
        quantity: decimal,
        unit: optText(20),
        unitPrice: decimal,
        taxCategoryId: z.uuid().optional(),
      }),
    )
    .min(1)
    .max(500)
    .optional(),
  acknowledgedFlags: z.array(z.string().max(64)).max(100),
  acknowledgedDuplicates: z.boolean().optional(),
}) satisfies z.ZodType<ImportDecisions, unknown>;
