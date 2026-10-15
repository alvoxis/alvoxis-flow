import Decimal from "decimal.js";
import { type DocumentType } from "../domain/types";
import { type DuplicateCandidate, type ImportReview } from "./review";

export interface ExistingDocumentRef {
  id: string;
  type: DocumentType;
  number: string | null;
  issueDate: string;
  currency: string;
  grossTotal: string | null;
  sellerName: string | null;
  buyerName: string | null;
  sourceFileSha256: string | null;
}

const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const sameAmount = (a: string | null, b: string | null) =>
  a !== null && b !== null && new Decimal(a).abs().equals(new Decimal(b).abs());

/**
 * Finds documents the imported PDF may duplicate. Matches are reported with their reasons; the
 * user decides. A certain match (identical file, or same number + type + date) must be
 * acknowledged explicitly before a draft can be created.
 */
export function findDuplicates(
  review: ImportReview,
  existing: readonly ExistingDocumentRef[],
): DuplicateCandidate[] {
  const out: DuplicateCandidate[] = [];
  const number = norm(review.number.value);
  const total = review.totals.total.value;
  const parties = [norm(review.buyer.name.value), norm(review.seller.name.value)].filter(
    (p) => p.length >= 3,
  );

  for (const doc of existing) {
    const reasons: DuplicateCandidate["reasons"] = [];
    if (doc.sourceFileSha256 && doc.sourceFileSha256 === review.fileSha256)
      reasons.push("same_file");
    const typeCompatible = !review.documentType.value || review.documentType.value === doc.type;
    const sameDate = review.issueDate.value === doc.issueDate;
    if (number && norm(doc.number) === number && typeCompatible) reasons.push("same_number");
    const totalMatches =
      sameAmount(total, doc.grossTotal) &&
      (!review.currency.value || review.currency.value === doc.currency);
    const partyMatches = parties.some((p) =>
      [norm(doc.buyerName), norm(doc.sellerName)].some(
        (q) => q.length >= 3 && (q.includes(p) || p.includes(q)),
      ),
    );
    if (sameDate && totalMatches && partyMatches) reasons.push("same_party_date_total");
    else if (sameDate && totalMatches) reasons.push("same_date_total");
    if (reasons.length === 0) continue;

    const strength: DuplicateCandidate["strength"] =
      reasons.includes("same_file") || (reasons.includes("same_number") && sameDate)
        ? "certain"
        : reasons.includes("same_number") || reasons.includes("same_party_date_total")
          ? "likely"
          : "possible";
    out.push({ documentId: doc.id, number: doc.number, reasons, strength });
  }
  const rank = { certain: 0, likely: 1, possible: 2 };
  return out.sort((a, b) => rank[a.strength] - rank[b.strength]);
}
