import Decimal from "decimal.js";
import { type AppLocale } from "@/i18n/config";
import { lineNet } from "./calculate";
import {
  type DocumentDraft,
  type DocumentLine,
  type IssuedDocument,
  type PartySnapshot,
} from "./types";

export class DocumentRuleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DocumentRuleError";
  }
}

export interface CreditRequest {
  sourceLineId: string;
  /** Positive quantity to credit. */
  quantity: string;
  /** Positive unit price to credit; defaults to the original unit price (price corrections use less). */
  unitPrice?: string;
  description?: string;
}

export interface DeriveParams {
  newLineId: () => string;
  issueDate: string;
  language?: AppLocale;
  /** Current seller details; defaults to the snapshot on the original document. */
  seller?: PartySnapshot;
}

function requireIssued(doc: IssuedDocument, type: IssuedDocument["type"]) {
  if (doc.status !== "issued" || doc.type !== type) {
    throw new DocumentRuleError("source.invalid", `Expected an issued ${type}`);
  }
}

/**
 * Builds a credit-note draft for an ISSUED invoice. The credit note keeps the invoice's currency
 * and its exchange-rate snapshot (no re-conversion), copies each credited line's tax category, and
 * refuses to credit more than remains on any line, taking earlier credit notes into account.
 */
export function buildCreditNote(
  original: IssuedDocument,
  requests: readonly CreditRequest[],
  previousCreditLines: readonly DocumentLine[],
  params: DeriveParams,
): DocumentDraft {
  requireIssued(original, "invoice");
  if (requests.length === 0) throw new DocumentRuleError("creditNote.empty", "Nothing to credit");
  if (params.issueDate < original.issueDate) {
    throw new DocumentRuleError(
      "creditNote.dateBeforeOriginal",
      "Credit note cannot predate the invoice",
    );
  }

  const originalLines = new Map(original.lines.map((l) => [l.id, l]));

  const lines: DocumentLine[] = requests.map((req) => {
    const src = originalLines.get(req.sourceLineId);
    if (!src || src.unitPrice === null) {
      throw new DocumentRuleError(
        "creditNote.sourceLine.unknown",
        `Line ${req.sourceLineId} is not on the invoice`,
      );
    }
    const qty = new Decimal(req.quantity);
    const unitPrice = req.unitPrice ?? src.unitPrice;
    if (!qty.isPositive() || qty.isZero())
      throw new DocumentRuleError(
        "creditNote.quantity.invalid",
        "Credit quantity must be positive",
      );
    if (new Decimal(unitPrice).isNegative())
      throw new DocumentRuleError("creditNote.unitPrice.invalid", "Unit price must be positive");
    if (new Decimal(unitPrice).gt(src.unitPrice)) {
      throw new DocumentRuleError(
        "creditNote.unitPrice.exceedsOriginal",
        "Credited unit price exceeds the original",
      );
    }

    const creditLine: DocumentLine = {
      id: params.newLineId(),
      kind: src.kind,
      description: req.description ?? src.description,
      quantity: qty.negated().toFixed(),
      unit: src.unit,
      unitPrice,
      discountPercent: src.discountPercent,
      taxCategory: src.taxCategory,
      sourceLineId: src.id,
    };
    return creditLine;
  });

  assertCreditWithinRemaining(original, lines, previousCreditLines);

  return {
    type: "credit_note",
    language: params.language ?? original.language,
    currency: original.currency,
    issueDate: params.issueDate,
    seller: params.seller ?? original.seller,
    buyer: original.buyer,
    bankAccounts: original.bankAccounts,
    buyerReference: original.buyerReference,
    footer: original.footer,
    lines,
    relation: {
      kind: "credits",
      documentId: original.id,
      documentNumber: original.number,
      issueDate: original.issueDate,
    },
    ...(original.exchangeRate ? { exchangeRate: original.exchangeRate } : {}),
  };
}

/**
 * Ensures that `creditLines` together with `previousCreditLines` (issued credit notes for the same
 * invoice) do not exceed any original line's quantity or net amount. Used both when building a
 * credit note and again when issuing it, because several drafts may exist concurrently.
 */
export function assertCreditWithinRemaining(
  original: Pick<IssuedDocument, "lines" | "currency">,
  creditLines: readonly DocumentLine[],
  previousCreditLines: readonly DocumentLine[],
): void {
  const originalLines = new Map(original.lines.map((l) => [l.id, l]));
  const all = [...previousCreditLines, ...creditLines];
  const perSource = new Map<string, { qty: Decimal; net: Decimal }>();
  for (const l of all) {
    const src = l.sourceLineId ? originalLines.get(l.sourceLineId) : undefined;
    if (!src)
      throw new DocumentRuleError(
        "creditNote.sourceLine.unknown",
        `Credit line ${l.id} has no valid source line`,
      );
    const acc = perSource.get(src.id) ?? { qty: new Decimal(0), net: new Decimal(0) };
    perSource.set(src.id, {
      qty: acc.qty.plus(new Decimal(l.quantity).abs()),
      net: acc.net.plus(new Decimal(lineNet(l, original).toDecimalString()).abs()),
    });
  }
  for (const [srcId, sum] of perSource) {
    const src = originalLines.get(srcId)!;
    if (sum.qty.gt(new Decimal(src.quantity))) {
      throw new DocumentRuleError(
        "creditNote.quantity.exceedsRemaining",
        `Credited quantity exceeds remaining quantity on line ${srcId}`,
      );
    }
    if (sum.net.gt(new Decimal(lineNet(src, original).toDecimalString()))) {
      throw new DocumentRuleError(
        "creditNote.amount.exceedsRemaining",
        `Credited amount exceeds remaining amount on line ${srcId}`,
      );
    }
  }
}

/** Credits everything that remains on the invoice. */
export function buildFullCreditNote(
  original: IssuedDocument,
  previousCreditLines: readonly DocumentLine[],
  params: DeriveParams,
): DocumentDraft {
  const requests = original.lines
    .map((l) => {
      const credited = previousCreditLines
        .filter((c) => c.sourceLineId === l.id)
        .reduce((a, c) => a.plus(new Decimal(c.quantity).abs()), new Decimal(0));
      return { sourceLineId: l.id, quantity: new Decimal(l.quantity).minus(credited).toFixed() };
    })
    .filter((r) => new Decimal(r.quantity).gt(0));
  if (requests.length === 0)
    throw new DocumentRuleError("creditNote.nothingRemaining", "Invoice is already fully credited");
  return buildCreditNote(original, requests, previousCreditLines, params);
}

/** Delivery note listing the goods of an issued invoice, without prices or tax. */
export function buildDeliveryNoteFromInvoice(
  original: IssuedDocument,
  params: DeriveParams,
): DocumentDraft {
  requireIssued(original, "invoice");
  return {
    type: "delivery_note",
    language: params.language ?? original.language,
    currency: original.currency,
    issueDate: params.issueDate,
    seller: params.seller ?? original.seller,
    buyer: original.buyer,
    bankAccounts: [],
    buyerReference: original.buyerReference,
    lines: original.lines
      .filter((l) => l.kind === "item")
      .map((l) => ({
        id: params.newLineId(),
        kind: "item" as const,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unitPrice: null,
        taxCategory: null,
        weightKg: l.weightKg,
        sourceLineId: l.id,
      })),
    relation: {
      kind: "delivers",
      documentId: original.id,
      documentNumber: original.number,
      issueDate: original.issueDate,
    },
  };
}

/** Invoice draft created from an issued proforma; the proforma itself stays unchanged. */
export function convertProformaToInvoice(
  proforma: IssuedDocument,
  params: DeriveParams & { dueDate?: string },
): DocumentDraft {
  requireIssued(proforma, "proforma");
  return {
    type: "invoice",
    language: params.language ?? proforma.language,
    currency: proforma.currency,
    issueDate: params.issueDate,
    ...(params.dueDate ? { dueDate: params.dueDate } : {}),
    seller: params.seller ?? proforma.seller,
    buyer: proforma.buyer,
    bankAccounts: proforma.bankAccounts,
    buyerReference: proforma.buyerReference,
    paymentTerms: proforma.paymentTerms,
    notes: proforma.notes,
    footer: proforma.footer,
    lines: proforma.lines.map((l) => ({ ...l, id: params.newLineId(), sourceLineId: l.id })),
    relation: {
      kind: "converted_from",
      documentId: proforma.id,
      documentNumber: proforma.number,
      issueDate: proforma.issueDate,
    },
    // A proforma rate snapshot is NOT carried over: the invoice needs its own rate decision.
  };
}
