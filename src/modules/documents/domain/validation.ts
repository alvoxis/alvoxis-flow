import Decimal from "decimal.js";
import { isCurrencyCode } from "@/lib/money";
import { isValidIban } from "@/lib/iban";
import { LOCALES } from "@/i18n/config";
import { calculateTotals } from "./calculate";
import {
  type DocumentDraft,
  type DocumentLine,
  isPricedDocument,
  TAX_TREATMENT_KINDS,
  type TaxCategorySnapshot,
} from "./types";

export type IssueSeverity = "error" | "warning";

/**
 * A validation finding. `code` is stable and translatable; `path` points at the field.
 * Warnings never block issuing. None of these rules claim legal completeness: mandatory content
 * per country must be added as verified country profiles.
 */
export interface ValidationIssue {
  code: string;
  severity: IssueSeverity;
  path: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

function decimals(v: string): number {
  return v.split(".")[1]?.length ?? 0;
}

function isValidDate(v: string | undefined): boolean {
  if (!v || !DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export const LIMITS = {
  quantityDecimals: 4,
  unitPriceDecimals: 4,
  discountDecimals: 2,
  rateDecimals: 2,
  descriptionLength: 1000,
  lines: 500,
} as const;

function validateLine(
  doc: DocumentDraft,
  line: DocumentLine,
  i: number,
  issues: ValidationIssue[],
) {
  const p = `lines[${i}]`;
  const add = (code: string, path: string, severity: IssueSeverity = "error") =>
    issues.push({ code, path, severity });
  const priced = isPricedDocument(doc.type);

  if (!line.description.trim()) add("line.description.required", `${p}.description`);
  if (line.description.length > LIMITS.descriptionLength)
    add("line.description.tooLong", `${p}.description`);

  if (!DECIMAL.test(line.quantity) || decimals(line.quantity) > LIMITS.quantityDecimals) {
    add("line.quantity.invalid", `${p}.quantity`);
  } else {
    const q = new Decimal(line.quantity);
    if (q.isZero()) add("line.quantity.zero", `${p}.quantity`);
    if (doc.type === "credit_note" && q.isPositive() && !q.isZero())
      add("creditNote.line.quantity.mustBeNegative", `${p}.quantity`);
    if (doc.type === "delivery_note" && q.isNegative())
      add("deliveryNote.line.quantity.mustBePositive", `${p}.quantity`);
  }

  if (line.unitPrice === null) {
    if (priced) add("line.unitPrice.required", `${p}.unitPrice`);
  } else if (!DECIMAL.test(line.unitPrice) || decimals(line.unitPrice) > LIMITS.unitPriceDecimals) {
    add("line.unitPrice.invalid", `${p}.unitPrice`);
  } else if (doc.type === "credit_note" && new Decimal(line.unitPrice).isNegative()) {
    add("creditNote.line.unitPrice.mustBePositive", `${p}.unitPrice`);
  }

  if (line.discountPercent !== undefined) {
    const d = line.discountPercent;
    if (
      !DECIMAL.test(d) ||
      decimals(d) > LIMITS.discountDecimals ||
      new Decimal(d).lt(0) ||
      new Decimal(d).gt(100)
    ) {
      add("line.discount.invalid", `${p}.discountPercent`);
    }
  }

  if (
    line.weightKg !== undefined &&
    (!DECIMAL.test(line.weightKg) || new Decimal(line.weightKg).lt(0))
  ) {
    add("line.weight.invalid", `${p}.weightKg`);
  }

  const cat = line.taxCategory;
  if (!cat) {
    if (priced) add("line.taxCategory.required", `${p}.taxCategory`);
    return;
  }
  issues.push(...validateTaxCategory(cat, `${p}.taxCategory`));
}

/**
 * Technical consistency of a tax category (used for line snapshots and for the company catalog).
 * These are format rules, not country tax law: which treatment and rate apply is the user's
 * decision. `prefix` is prepended to paths ("" → "kind", "ratePercent", …).
 */
export function validateTaxCategory(
  cat: Pick<TaxCategorySnapshot, "kind" | "ratePercent" | "note">,
  prefix = "",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const at = (field: string) => (prefix ? (field ? `${prefix}.${field}` : prefix) : field);
  const add = (code: string, path: string, severity: IssueSeverity = "error") =>
    issues.push({ code, path, severity });
  if (!(TAX_TREATMENT_KINDS as readonly string[]).includes(cat.kind))
    add("tax.kind.invalid", at("kind"));
  if (
    !DECIMAL.test(cat.ratePercent) ||
    decimals(cat.ratePercent) > LIMITS.rateDecimals ||
    new Decimal(cat.ratePercent).lt(0) ||
    new Decimal(cat.ratePercent).gte(100)
  ) {
    add("tax.rate.invalid", at("ratePercent"));
    return issues;
  }
  const rate = new Decimal(cat.ratePercent);
  // A bare "0%" is ambiguous (seen in real examples). Force an explicit treatment instead.
  if (cat.kind === "standard" && rate.isZero()) add("tax.rate.zeroRequiresTreatment", at(""));
  if (cat.kind !== "standard" && !rate.isZero())
    add("tax.rate.mustBeZeroForTreatment", at("ratePercent"));
  if (cat.kind !== "standard" && !cat.note?.trim())
    add("tax.note.recommended", at("note"), "warning");
  return issues;
}

export function validateDocument(doc: DocumentDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: string, path: string, severity: IssueSeverity = "error") =>
    issues.push({ code, path, severity });

  if (!isCurrencyCode(doc.currency)) add("currency.unsupported", "currency");
  if (!(LOCALES as readonly string[]).includes(doc.language))
    add("language.unsupported", "language");

  if (!isValidDate(doc.issueDate)) add("date.invalid", "issueDate");
  for (const key of ["dueDate", "supplyDate", "validUntil"] as const) {
    if (doc[key] !== undefined && !isValidDate(doc[key])) add("date.invalid", key);
  }
  if (isValidDate(doc.dueDate) && isValidDate(doc.issueDate) && doc.dueDate! < doc.issueDate)
    add("dueDate.beforeIssueDate", "dueDate");
  if (doc.validUntil !== undefined && doc.type !== "proforma")
    add("validUntil.onlyForProforma", "validUntil", "warning");

  if (!doc.seller.name.trim()) add("seller.name.required", "seller.name");
  if (!doc.seller.address?.lines.some((l) => l.trim()))
    add("seller.address.required", "seller.address");
  if (!doc.seller.registrationNumber && !doc.seller.vatNumber)
    add("seller.identifier.missing", "seller", "warning");
  if (!doc.buyer.name.trim()) add("buyer.name.required", "buyer.name");

  doc.bankAccounts.forEach((b, i) => {
    if (!isValidIban(b.iban)) add("bankAccount.iban.invalid", `bankAccounts[${i}].iban`);
  });
  if (doc.type === "invoice" && doc.bankAccounts.length === 0)
    add("bankAccount.missing", "bankAccounts", "warning");

  if (doc.lines.length === 0) add("lines.required", "lines");
  if (doc.lines.length > LIMITS.lines) add("lines.tooMany", "lines");
  const ids = new Set<string>();
  doc.lines.forEach((line, i) => {
    if (ids.has(line.id)) add("line.id.duplicate", `lines[${i}].id`);
    ids.add(line.id);
    validateLine(doc, line, i, issues);
  });

  if (doc.type === "credit_note") {
    if (doc.relation?.kind !== "credits") add("creditNote.originalInvoice.required", "relation");
    if (doc.lines.some((l) => !l.sourceLineId)) add("creditNote.line.source.required", "lines");
  }

  if (doc.exchangeRate && doc.exchangeRate.from !== doc.currency)
    add("exchangeRate.currencyMismatch", "exchangeRate");

  // Totals-level checks only when the lines themselves are valid.
  if (
    isPricedDocument(doc.type) &&
    doc.lines.length > 0 &&
    !issues.some((x) => x.severity === "error" && x.path.startsWith("lines"))
  ) {
    const totals = calculateTotals({ ...doc, exchangeRate: undefined });
    const gross = new Decimal(totals.grossTotal);
    if (
      doc.type === "credit_note"
        ? !gross.isNegative() || gross.isZero()
        : !gross.isPositive() || gross.isZero()
    ) {
      add(
        doc.type === "credit_note" ? "creditNote.total.mustBeNegative" : "total.mustBePositive",
        "lines",
      );
    }
  }

  return issues;
}

export function hasBlockingIssues(issues: readonly ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
