import Decimal from "decimal.js";
import { type AppLocale } from "@/i18n/config";
import { type CurrencyCode } from "@/lib/money";
import { type DraftInput } from "../domain/schema";
import { type BankAccountSnapshot, type DocumentType, type PartySnapshot } from "../domain/types";
import { type ImportReview } from "./review";

export class ImportDecisionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportDecisionError";
  }
}

export interface ReviewedLine {
  description: string;
  quantity: string;
  unit?: string;
  unitPrice: string;
  /** Company tax category (id) chosen by the user for this line; overrides the default. */
  taxCategoryId?: string;
}

/**
 * Everything the user confirmed on the review screen. Values default to nothing: the user must
 * provide parties, dates and — always — the tax treatment, because it is never inferred.
 */
export interface ImportDecisions {
  type: Exclude<DocumentType, "credit_note">;
  language: AppLocale;
  currency: CurrencyCode;
  issueDate: string;
  dueDate?: string;
  seller: PartySnapshot;
  buyer: PartySnapshot;
  bankAccounts: BankAccountSnapshot[];
  buyerReference?: string;
  paymentTerms?: string;
  notes?: string;
  /**
   * Company tax category (id) applied to every line without its own. Required; the server
   * resolves it against the company catalog when the draft is created.
   */
  defaultTaxCategoryId: string;
  /** Edited lines; when omitted, extracted lines are used as-is (must be complete). */
  lines?: ReviewedLine[];
  /** Codes of warning/error flags the user has looked at and accepted. */
  acknowledgedFlags: string[];
  /** Required when a certain/likely duplicate was found. */
  acknowledgedDuplicates?: boolean;
}

/** Turns a reviewed import into draft input. Refuses while anything is unresolved. */
export function toDraftInput(review: ImportReview, d: ImportDecisions): DraftInput {
  const open = review.flags.filter(
    (f) => f.severity !== "info" && !d.acknowledgedFlags.includes(f.code),
  );
  if (open.length) {
    throw new ImportDecisionError(
      "import.flags.unresolved",
      `Unresolved import findings: ${[...new Set(open.map((f) => f.code))].join(", ")}`,
    );
  }
  if (review.duplicates.some((c) => c.strength !== "possible") && !d.acknowledgedDuplicates) {
    throw new ImportDecisionError(
      "import.duplicates.unacknowledged",
      "The file may already exist; confirm before creating a document",
    );
  }

  const lines: ReviewedLine[] =
    d.lines ??
    review.lines.map((l, i) => {
      let unitPrice = l.unitPrice;
      if (!unitPrice && l.quantity && l.total && !new Decimal(l.quantity).isZero()) {
        const derived = new Decimal(l.total).dividedBy(l.quantity);
        // Only derive a unit price when it is exact to 4 decimals; otherwise ask the user.
        if (derived.decimalPlaces() <= 4) unitPrice = derived.toFixed();
      }
      if (!l.quantity || !unitPrice) {
        throw new ImportDecisionError(
          "import.line.incomplete",
          `Line ${i + 1} needs a quantity and unit price`,
        );
      }
      if (l.flags.length && !l.flags.every((f) => d.acknowledgedFlags.includes(f))) {
        throw new ImportDecisionError(
          "import.line.flagsUnresolved",
          `Line ${i + 1}: ${l.flags.join(", ")}`,
        );
      }
      return {
        description: l.description,
        quantity: l.quantity,
        unit: l.unit ?? undefined,
        unitPrice,
      };
    });

  return {
    type: d.type,
    language: d.language,
    currency: d.currency,
    issueDate: d.issueDate,
    ...(d.dueDate ? { dueDate: d.dueDate } : {}),
    seller: d.seller,
    buyer: d.buyer,
    bankAccounts: d.bankAccounts,
    ...(d.buyerReference ? { buyerReference: d.buyerReference } : {}),
    ...(d.paymentTerms ? { paymentTerms: d.paymentTerms } : {}),
    ...(d.notes ? { notes: d.notes } : {}),
    lines: lines.map((l) => ({
      kind: "item" as const,
      description: l.description,
      quantity: l.quantity,
      ...(l.unit ? { unit: l.unit } : {}),
      unitPrice: l.unitPrice,
      taxCategoryId: l.taxCategoryId ?? d.defaultTaxCategoryId,
    })),
  };
}
