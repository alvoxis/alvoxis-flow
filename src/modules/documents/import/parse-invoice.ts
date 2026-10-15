import Decimal from "decimal.js";
import { type CurrencyCode } from "@/lib/money";
import { isValidIban, normalizeIban } from "@/lib/iban";
import { type DocumentType } from "../domain/types";
import { type LayoutPage } from "./extract";
import { findAllDates, parseAmount, parseDate, parseQuantity } from "./parse-values";
import {
  type Confidence,
  type ExtractedIdentifier,
  type ExtractedLine,
  type Field,
  type ImportFlag,
  type ImportReview,
} from "./review";

/**
 * Heuristic reader for text-based invoice PDFs. Design rules:
 *  - never guess silently: every value carries a confidence and the text it came from;
 *  - inconsistencies (arithmetic, dates, identifiers, currencies) become flags;
 *  - tax treatment is NEVER inferred — a printed rate is reported, not interpreted.
 * Keywords cover the five product languages plus Polish and the labels ALVOXIS Flow prints.
 */

const COL = /\s{3,}/;

const KW = {
  proforma: /pro\s?-?forma|проформ|avansa\s+rēķins|išankstinė|ettemaksuarve|faktura\s+proforma/i,
  creditNote: /credit\s+note|kredītrēķin|кредит-?нот|kreditinė|kreeditarve|faktura\s+korygująca/i,
  deliveryNote: /delivery\s+note|pavadzīm|накладн|važtaraštis|saateleht|wz\b/i,
  invoice: /invoice|\binv\.|rēķins|сч[её]т|sąskaita|\barve\b|faktura/i,
  buyer: /^(customer|buyer|bill\s+to|to:|klients|pircējs|покупатель|pirkėjas|ostja|nabywca)/i,
  seller: /^(from:|seller|supplier|pārdevējs|продавец|pardavėjas|müüja|sprzedawca)/i,
  dueDate:
    /(due|to\s+be\s+paid|pay\s+by|payable|termiņ|срок\s+оплаты|apmokėti\s+iki|maksetähtaeg|tähtaeg|termin\s+płatności)/i,
  issueDate: /(date|datums|дата|data|kuupäev)/i,
  subtotal:
    /(sub\s*total|subtotal|total\s+excl|net\s+total|kopā\s+bez|итого\s+без|iš\s+viso\s+be|kokku\s+ilma|razem\s+netto|vahesumma)/i,
  taxTotal:
    /(tax\s+total|total\s+tax|vat\s+total|tax\s+rate|vat\b|nodoklis\s+kopā|pvn|сумма\s+налога|ндс|mokesčių\s+suma|pvm|maks\s+kokku|käibemaks|podatek|tax\b)/i,
  total: /(grand\s+total|total|kopā|итого|iš\s+viso|kokku|razem|summa\s+apmaksai|do\s+zapłaty)/i,
  shipping: /(shipping|delivery\s+charge|piegāde|доставка|pristatymas|transport)/i,
  tableHeader:
    /(qty|quantity|pcs|daudz|кол|kiekis|kogus|ilość).*(price|cena|цена|kaina|hind|eur|total|summa|amount)|description.*(price|amount|total)/i,
  reference:
    /(p\.?\s?o\.?\s*(number|no)?|order\s+(reference|no|number)|your\s+reference|pasūtījuma\s+numurs|номер\s+заказа|užsakymo\s+numeris|tellimuse\s+number|zamówienie)/i,
  paymentTerms:
    /(payment\s+terms|apmaksas\s+noteikumi|условия\s+оплаты|mokėjimo\s+sąlygos|maksetingimused|warunki\s+płatności)/i,
  registration:
    /(reg\.?\s*(nr|no|number|kods|code)?\.?|reģ\.?\s*nr|рег\.?\s*№|įm\.\s*kodas|reg\.\s*kood|regon|krs)/i,
  vat: /(vat|pvn|ндс|pvm|kmkr|nip)\s*(no\.?|nr\.?|number|№|kodas)?/i,
  statement:
    /(transit|exempt|reverse\s+charge|art\.|article|§|directive|atbrīvo|apgriezt|освобожд|обратн|neapmokestin|atvirkštin|maksuvaba|pöördmaks|zwolnion|odwrotne)/i,
  legalForm: /\b(SIA|AS|UAB|AB|OÜ|MB|IĮ|Sp\.\s?z\s?o\.?o\.?|S\.A\.|Ltd\.?|LLC|GmbH|Oy|ООО|АО)\b/,
  number:
    /(?:invoice|rēķins|сч[её]т|sąskaita(?:\s+faktūra)?|arve|faktura|proforma|pro\s?forma|credit\s+note|delivery\s+note|\binv\.)?\s*(?:no\.?|nr\.?|№|number|#)?\s*[:.]?\s*([A-Z]{0,6}[-/]?\d[\w\-/.]*\d[\w]*|\d+)/i,
};

const CURRENCY_PATTERNS: [CurrencyCode, RegExp][] = [
  ["EUR", /€|\bEUR\b/],
  ["PLN", /\bPLN\b|zł/i],
];

function field<T>(value: T | null, confidence: Confidence, evidence?: string): Field<T> {
  return evidence === undefined ? { value, confidence } : { value, confidence, evidence };
}

const cells = (line: string) =>
  line
    .split(COL)
    .map((c) => c.trim())
    .filter(Boolean);
const isCurrencyOnly = (c: string) => /^(€|eur|pln|zł)$/i.test(c.trim());

/** Value written after a "Label:" in the same cell, or the next cell. */
function labelledValue(line: string, label: RegExp): string | null {
  const parts = cells(line);
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i]!.match(label);
    if (!m) continue;
    const rest = parts[i]!.slice((m.index ?? 0) + m[0].length)
      .replace(/^[\s:.#-]+/, "")
      .trim();
    if (rest) return rest;
    if (parts[i + 1]) return parts[i + 1]!;
  }
  return null;
}

export function detectDocumentType(text: string): Field<DocumentType> {
  const head = text.split("\n").slice(0, 15).join("\n");
  const hits: [DocumentType, boolean][] = [
    ["proforma", KW.proforma.test(head)],
    ["credit_note", KW.creditNote.test(head)],
    ["delivery_note", KW.deliveryNote.test(head)],
    ["invoice", KW.invoice.test(head)],
  ];
  const found = hits.filter(([, hit]) => hit).map(([t]) => t);
  if (found.length === 0) return field<DocumentType>(null, "low");
  // Specific types win over the generic word "invoice" ("Proforma invoice", "Credit note to invoice").
  return field(
    found[0]!,
    found.length === 1 ? "high" : "medium",
    head.split("\n").find((l) => /\S/.test(l)),
  );
}

function detectNumber(lines: string[]): Field<string> {
  for (const line of lines.slice(0, 15)) {
    if (!/(no\.?|nr\.?|№|number|inv\.|#)\s*[:.]?\s*\S*\d/i.test(line)) continue;
    if (
      KW.registration.test(line) ||
      KW.vat.test(line) ||
      /iban|swift|bic|tel|phone|p\.?\s?o\b/i.test(line)
    )
      continue;
    const m = line.match(
      /(?:no\.?|nr\.?|№|number|inv\.|#)\s*[:.]?\s*([A-Z]{0,6}[-/]?\d[\w\-/.]*)/i,
    );
    if (m?.[1]) return field(m[1].replace(/[.,;:]$/, ""), "medium", line.trim());
  }
  return field<string>(null, "low");
}

function detectDates(lines: string[], flags: ImportFlag[]) {
  let issue: Field<string> = field<string>(null, "low");
  let due: Field<string> = field<string>(null, "low");

  const take = (label: RegExp, exclude?: RegExp): Field<string> | null => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const parts = cells(line);
      const idx = parts.findIndex((p) => label.test(p) && !(exclude && exclude.test(p)));
      if (idx === -1) continue;
      // Same cell / following cell on the same line.
      const sameLine = [parts[idx]!, parts[idx + 1] ?? ""].join(" ");
      let parsed = parseDate(sameLine.replace(/^[^:]*:/, (m) => (parseDate(m).value ? m : "")));
      let evidence = line.trim();
      if (!parsed.value) {
        // Label row with the value directly below, in the same column (header/value grids).
        const next = lines[i + 1];
        if (next) {
          const below = cells(next);
          const candidate =
            below.length === parts.length ? below[idx] : below.find((c) => parseDate(c).value);
          if (candidate) {
            parsed = parseDate(candidate);
            evidence = `${line.trim()} / ${next.trim()}`;
          }
        }
      }
      if (parsed.value) return field(parsed.value, parsed.ambiguous ? "low" : "high", evidence);
    }
    return null;
  };

  due = take(KW.dueDate) ?? due;
  issue = take(KW.issueDate, KW.dueDate) ?? issue;

  if (!issue.value) {
    const all = findAllDates(lines.join("\n"));
    if (all.length) {
      const p = parseDate(all[0]!);
      issue = field(p.value, "low", all[0]);
      flags.push({ code: "issueDate.unlabelled", severity: "warning", field: "issueDate" });
    }
  }
  for (const [name, f] of [
    ["issueDate", issue],
    ["dueDate", due],
  ] as const) {
    if (f.value && f.confidence === "low" && f.evidence && /\d\/\d/.test(f.evidence)) {
      flags.push({
        code: "date.formatAmbiguous",
        severity: "warning",
        field: name,
        detail: "Could be day/month or month/day",
      });
    }
  }
  if (issue.value && due.value && due.value < issue.value) {
    flags.push({ code: "dueDate.beforeIssueDate", severity: "warning", field: "dueDate" });
  }
  return { issue, due };
}

function detectCurrency(text: string, flags: ImportFlag[]): Field<CurrencyCode> {
  const found = CURRENCY_PATTERNS.filter(([, re]) => re.test(text)).map(([c]) => c);
  if (found.length === 1) return field(found[0]!, "high");
  if (found.length > 1) {
    flags.push({
      code: "currency.multiple",
      severity: "warning",
      field: "currency",
      detail: found.join(", "),
    });
    return field<CurrencyCode>(null, "low");
  }
  flags.push({ code: "currency.notFound", severity: "error", field: "currency" });
  return field<CurrencyCode>(null, "low");
}

/** Splits a two-column party block (seller left, buyer right) when the buyer heading is on the right. */
function detectParties(lines: string[], tableStart: number) {
  const seller: string[] = [];
  const buyer: string[] = [];
  const end = tableStart === -1 ? lines.length : tableStart;
  let buyerIdx = -1;
  let buyerCol = 0;
  for (let i = 0; i < end; i++) {
    const parts = cells(lines[i]!);
    const c = parts.findIndex((p) => KW.buyer.test(p));
    if (c !== -1) {
      buyerIdx = i;
      buyerCol = c;
      break;
    }
  }
  if (buyerIdx === -1) return { seller, buyer, confidence: "low" as Confidence };

  if (buyerCol > 0) {
    // Two-column layout: left cells belong to the seller, right cells to the buyer.
    for (let i = buyerIdx; i < end; i++) {
      const parts = cells(lines[i]!);
      if (parts.length >= 2) {
        seller.push(parts.slice(0, Math.max(1, parts.length - 1)).join(" "));
        buyer.push(parts[parts.length - 1]!);
      } else if (parts[0]) seller.push(parts[0]);
    }
    for (let i = 0; i < buyerIdx; i++)
      if (KW.legalForm.test(lines[i]!)) seller.unshift(lines[i]!.trim());
  } else {
    const firstLine = lines[buyerIdx]!.replace(KW.buyer, "").trim();
    if (firstLine) buyer.push(firstLine);
    for (let i = buyerIdx + 1; i < end && buyer.length < 8; i++) {
      // Drop "Date: …" cells that share the line with buyer details.
      const parts = cells(lines[i]!);
      const kept: string[] = [];
      for (let c = 0; c < parts.length; c++) {
        if (KW.issueDate.test(parts[c]!) && /:\s*$/.test(parts[c]!)) {
          c++;
          continue;
        }
        if (parseDate(parts[c]!).value && parts[c]!.length <= 12) continue;
        kept.push(parts[c]!);
      }
      if (kept.length) buyer.push(kept.join("   "));
    }
    for (let i = 0; i < buyerIdx; i++) seller.push(lines[i]!.trim());
  }
  return { seller, buyer, confidence: "medium" as Confidence };
}

function nameFrom(block: string[]): Field<string> {
  for (const l of block) {
    const named = labelledValue(l, /^(name|nosaukums|наименование|pavadinimas|nimi)\s*:?/i);
    if (named) return field(named, "medium", l);
  }
  const withForm = block.find((l) => KW.legalForm.test(l));
  if (withForm) return field(withForm.replace(/^(from|to)\s*:\s*/i, "").trim(), "medium", withForm);
  const first = block.find((l) => l && !KW.seller.test(l) && !KW.buyer.test(l));
  return first
    ? field(first.replace(/^(from|to)\s*:\s*/i, "").trim(), "low", first)
    : field<string>(null, "low");
}

function detectIdentifiers(
  lines: string[],
  seller: string[],
  buyer: string[],
  flags: ImportFlag[],
): ExtractedIdentifier[] {
  const out: ExtractedIdentifier[] = [];
  const side = (value: string): ExtractedIdentifier["side"] =>
    seller.some((l) => l.includes(value))
      ? "seller"
      : buyer.some((l) => l.includes(value))
        ? "buyer"
        : "unknown";
  const seen = new Set<string>();
  for (const line of lines) {
    if (/iban|swift|bic/i.test(line)) continue;
    const lineCells = cells(line);
    for (let ci = 0; ci < lineCells.length; ci++) {
      const part = lineCells[ci]!;
      if (/(phone|tel|office|mob|fax|тел|tālr|telefon)/i.test(`${lineCells[ci - 1] ?? ""} ${part}`))
        continue;
      const ids = part.match(/\b(?:[A-Z]{2}\s?)?\d{8,12}\b/g);
      if (!ids) continue;
      for (const raw of ids) {
        const value = raw.replace(/\s/g, "");
        if (seen.has(value) || /^\d{1,2}[./]/.test(part) || value.length > 14) continue;
        seen.add(value);
        const label = KW.vat.test(part)
          ? "vat"
          : KW.registration.test(part)
            ? "registration"
            : null;
        const id: ExtractedIdentifier = {
          label: label
            ? part
                .replace(raw, "")
                .replace(/[:\s]+$/, "")
                .trim()
            : null,
          value,
          kind: label === "vat" ? "vat" : label === "registration" ? "registration" : "unknown",
          side: side(raw),
          evidence: line.trim(),
        };
        if (!label)
          flags.push({
            code: "identifier.unlabelled",
            severity: "warning",
            field: "identifiers",
            detail:
              "Identifier without a label: confirm whether it is a registration or VAT number",
          });
        if (label === "registration" && /^[A-Z]{2}\d/.test(value)) {
          flags.push({
            code: "identifier.labelMismatch",
            severity: "warning",
            field: "identifiers",
            detail: "Labelled as registration number but formatted like a VAT number",
          });
        }
        out.push(id);
      }
    }
  }
  return out;
}

function detectBankAccounts(lines: string[], flags: ImportFlag[]) {
  const accounts: ImportReview["bankAccounts"] = [];
  const bicMatch = lines
    .join("\n")
    .match(/(?:swift|bic)\s*[:/]?\s*(?:code)?\s*[:]?\s*([A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/i);
  for (const line of lines) {
    for (const m of line.matchAll(
      /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g,
    )) {
      const iban = normalizeIban(m[0]);
      // Real IBANs in the region are 20–28 characters; shorter tokens are usually company/VAT ids.
      if (iban.length < 15 || accounts.some((a) => a.iban === iban)) continue;
      const checksumValid = isValidIban(iban);
      const labelled = /iban|konts|счёт|счет|sąskaita|arveldus|rachunek|account/i.test(line);
      if (!checksumValid && !labelled) continue;
      if (!checksumValid)
        flags.push({ code: "bankAccount.ibanInvalid", severity: "error", field: "bankAccounts" });
      accounts.push({
        iban,
        checksumValid,
        bic: bicMatch?.[1]?.toUpperCase() ?? null,
        evidence: line.trim(),
      });
    }
  }
  return accounts;
}

/** Table rows: a quantity, a description and (for priced documents) unit price and total. */
function detectLines(lines: string[], tableStart: number, tableEnd: number): ExtractedLine[] {
  const out: ExtractedLine[] = [];
  const from = tableStart === -1 ? 0 : tableStart + 1;
  const to = tableEnd === -1 ? lines.length : tableEnd;
  for (let i = from; i < to; i++) {
    const raw = lines[i]!;
    // Split "10 pcs" style cells into quantity + unit.
    const parts = cells(raw)
      .filter((c) => !isCurrencyOnly(c))
      .flatMap((c) => {
        const m = c.match(/^(\d+(?:[.,]\d+)?)\s+([\p{L}.]{1,8})$/u);
        return m ? [m[1]!, `\u0000unit:${m[2]}`] : [c];
      });
    if (parts.length < 2) continue;
    const unitCell = parts.find((c) => c.startsWith("\u0000unit:"))?.slice(6) ?? null;
    const cleaned = parts.filter((c) => !c.startsWith("\u0000unit:"));
    const percentages = cleaned.filter((c) => /^\d+([.,]\d+)?\s?%$/.test(c));
    const rest = cleaned.filter((c) => !percentages.includes(c));
    const numeric = rest
      .map((c) => ({ c, amount: parseAmount(c) }))
      .filter((x) => x.amount.value !== null && !/[\p{L}]{2,}/u.test(x.c));
    const texts = rest.filter((c) => !numeric.some((n) => n.c === c));
    if (texts.length === 0 || numeric.length < 1) continue;

    const description = texts.reduce((a, b) => (b.length > a.length ? b : a));
    const unit =
      unitCell ??
      texts.find((t) => t !== description && t.length <= 6 && !/^(exempt|\d)/i.test(t)) ??
      null;
    const flags: string[] = [];
    let quantity: string | null = null;
    let unitPrice: string | null = null;
    let total: string | null = null;

    if (numeric.length >= 2 && (numeric.length >= 3 || tableStart !== -1)) {
      total = numeric[numeric.length - 1]!.amount.value;
      const before = numeric.slice(0, -1).map((n) => n.amount.value!);
      // Find quantity × price × (1 − discount%) = total among the earlier numbers, preferring
      // combinations without a discount. Leading row numbers are skipped naturally.
      const near = (x: Decimal) => x.minus(total!).abs().lte("0.01");
      let match: { q: string; p: string } | null = null;
      for (let a = 0; a < before.length && !match; a++) {
        for (let b = a + 1; b < before.length && !match; b++) {
          if (near(new Decimal(before[a]!).times(before[b]!)))
            match = { q: before[a]!, p: before[b]! };
        }
      }
      for (let a = 0; a < before.length && !match; a++) {
        for (let b = a + 1; b < before.length && !match; b++) {
          for (let c = b + 1; c < before.length && !match; c++) {
            const d = new Decimal(before[c]!);
            if (
              d.gt(0) &&
              d.lt(100) &&
              near(
                new Decimal(before[a]!)
                  .times(before[b]!)
                  .times(new Decimal(100).minus(d).dividedBy(100)),
              )
            ) {
              match = { q: before[a]!, p: before[b]! };
            }
          }
        }
      }
      if (match) {
        quantity = parseQuantity(match.q).value;
        unitPrice = match.p;
      } else if (numeric.length === 2) {
        // Only quantity and total printed.
        quantity = parseQuantity(numeric[0]!.c).value;
      } else {
        quantity = parseQuantity(numeric[numeric.length - 3]!.c).value;
        unitPrice = numeric[numeric.length - 2]!.amount.value;
        flags.push("line.arithmeticMismatch");
      }
      if (numeric.some((n) => n.amount.ambiguous)) flags.push("amount.ambiguous");
    } else if (numeric.length === 1 && tableStart !== -1) {
      // Delivery-note style rows: quantity only.
      quantity = parseQuantity(numeric[0]!.c).value;
    } else continue;

    out.push({
      description,
      quantity,
      unit,
      unitPrice,
      total,
      percentages,
      evidence: raw.trim(),
      flags,
    });
  }
  return out;
}

function lastAmount(line: string): { value: string | null; dash: boolean; ambiguous: boolean } {
  const parts = cells(line);
  for (let i = parts.length - 1; i >= 0; i--) {
    // Drop a leading label ("SUB TOTAL:", "Tax 20% ·") and keep the numeric tail of the cell.
    const tail = parts[i]!.replace(/^.*[A-Za-zĀ-žА-я%:·]\s*/, "").trim();
    const bare = tail.replace(/€|eur|pln|zł/gi, "").trim();
    if (/^[-–]$/.test(bare)) return { value: null, dash: true, ambiguous: false };
    if (!bare) continue;
    const a = parseAmount(tail);
    if (a.value !== null) return { value: a.value, dash: false, ambiguous: a.ambiguous };
  }
  return { value: null, dash: false, ambiguous: false };
}

function detectTotals(
  lines: string[],
  from: number,
  flags: ImportFlag[],
  hasTaxStatement: boolean,
) {
  const totals: ImportReview["totals"] = {
    subtotal: field<string>(null, "low"),
    shipping: field<string>(null, "low"),
    tax: field<string>(null, "low"),
    taxRateText: field<string>(null, "low"),
    total: field<string>(null, "low"),
  };
  for (let i = Math.max(from, 0); i < lines.length; i++) {
    const line = lines[i]!;
    const label = cells(line).find((c) => /[A-Za-zĀ-žА-я]/.test(c)) ?? "";
    const amt = lastAmount(line);
    const pct = line.match(/(\d+(?:[.,]\d+)?)\s?%/);
    if (KW.subtotal.test(label)) {
      if (amt.value)
        totals.subtotal = field(amt.value, amt.ambiguous ? "low" : "high", line.trim());
    } else if (KW.shipping.test(label)) {
      totals.shipping = field(amt.value ?? (amt.dash ? "0" : null), "medium", line.trim());
    } else if (KW.taxTotal.test(line) && !/grand\s+total/i.test(line)) {
      if (pct) totals.taxRateText = field(`${pct[1]}%`, "medium", line.trim());
      if (amt.value || amt.dash)
        totals.tax = field(amt.value ?? "0", amt.dash ? "medium" : "high", line.trim());
    } else if (
      cells(line).some((c) => KW.total.test(c) && !KW.subtotal.test(c)) &&
      !KW.tableHeader.test(line)
    ) {
      // The total label may follow an unrelated cell on the same line (e.g. "Comments:   TOTAL").
      if (amt.value) totals.total = field(amt.value, amt.ambiguous ? "low" : "high", line.trim());
    } else if (pct && !totals.taxRateText.value && /^\s*\d+([.,]\d+)?\s?%\s*$/.test(line)) {
      totals.taxRateText = field(`${pct[1]}%`, "low", line.trim());
    }
  }

  if (!totals.total.value)
    flags.push({ code: "total.notFound", severity: "error", field: "totals.total" });
  if (!totals.tax.value && !totals.taxRateText.value) {
    flags.push({
      code: "tax.notShown",
      severity: "warning",
      field: "totals.tax",
      detail: "No tax line found; choose the tax treatment manually",
    });
  }
  const rate = totals.taxRateText.value;
  if (rate && new Decimal(rate.replace("%", "").replace(",", ".")).isZero() && !hasTaxStatement) {
    flags.push({
      code: "tax.zeroRateUnexplained",
      severity: "warning",
      field: "totals.taxRateText",
      detail:
        "0% shown without a reason; zero-rated, exempt, reverse charge and out-of-scope cannot be told apart",
    });
  }
  // Always: the user decides the tax treatment.
  flags.push({ code: "tax.treatmentRequiresConfirmation", severity: "info", field: "totals" });
  return totals;
}

function crossCheck(
  review: Omit<ImportReview, "fileSha256" | "pageCount" | "duplicates">,
  flags: ImportFlag[],
) {
  const lineTotals = review.lines.map((l) => l.total).filter((t): t is string => t !== null);
  if (review.lines.some((l) => l.flags.includes("line.arithmeticMismatch"))) {
    flags.push({ code: "lines.arithmeticMismatch", severity: "warning", field: "lines" });
  }
  const sum = lineTotals.reduce((a, t) => a.plus(t), new Decimal(0));
  const { subtotal, shipping, tax, total } = review.totals;
  const base =
    subtotal.value ?? (tax.value === null || new Decimal(tax.value).isZero() ? total.value : null);
  if (lineTotals.length && base && !sum.equals(base)) {
    flags.push({
      code: "totals.linesMismatch",
      severity: "warning",
      field: "totals",
      detail: `Lines sum to ${sum.toFixed(2)}, document states ${base}`,
    });
  }
  if (subtotal.value && total.value) {
    const expected = new Decimal(subtotal.value).plus(shipping.value ?? 0).plus(tax.value ?? 0);
    if (!expected.equals(total.value)) {
      flags.push({
        code: "totals.sumMismatch",
        severity: "warning",
        field: "totals",
        detail: `Subtotal + shipping + tax = ${expected.toFixed(2)}, total = ${total.value}`,
      });
    }
  }
  if (review.lines.length === 0)
    flags.push({ code: "lines.notFound", severity: "error", field: "lines" });
  if (!review.number.value)
    flags.push({ code: "number.notFound", severity: "error", field: "number" });
  if (!review.issueDate.value)
    flags.push({ code: "issueDate.notFound", severity: "error", field: "issueDate" });
  if (!review.documentType.value)
    flags.push({ code: "documentType.unknown", severity: "error", field: "documentType" });
  if (!review.seller.name.value)
    flags.push({ code: "seller.notFound", severity: "warning", field: "seller" });
  if (!review.buyer.name.value)
    flags.push({ code: "buyer.notFound", severity: "warning", field: "buyer" });
}

export function parseInvoiceLayout(pages: LayoutPage[], fileSha256: string): ImportReview {
  const lines = pages.flatMap((p) => p.lines);
  const text = lines.join("\n");
  const flags: ImportFlag[] = [];

  if (lines.length === 0) {
    flags.push({
      code: "file.noTextLayer",
      severity: "error",
      detail: "No text found; scanned documents need OCR, which is not supported yet",
    });
  }

  const tableStart = lines.findIndex((l) => KW.tableHeader.test(l));
  let tableEnd = -1;
  for (let i = tableStart + 1; i < lines.length; i++) {
    const label = cells(lines[i]!)[0] ?? "";
    if (KW.subtotal.test(lines[i]!) || KW.total.test(label) || /^(shipping|tax)/i.test(label)) {
      tableEnd = i;
      break;
    }
  }

  const parties = detectParties(lines, tableStart);
  const statements = lines.filter((l) => KW.statement.test(l)).map((l) => l.trim());
  if (statements.length) {
    flags.push({
      code: "statements.found",
      severity: "info",
      field: "statements",
      detail: "Text that may have tax or legal meaning was found; it is shown, not interpreted",
    });
  }

  const { issue, due } = detectDates(lines, flags);
  const refValue = lines.map((l) => labelledValue(l, KW.reference)).find((v): v is string => !!v);
  const termsValue = lines
    .map((l) => labelledValue(l, KW.paymentTerms))
    .find((v): v is string => !!v);

  const partial = {
    status: "needs_review" as const,
    documentType: detectDocumentType(text),
    number: detectNumber(lines),
    issueDate: issue,
    dueDate: due,
    currency: detectCurrency(text, flags),
    seller: { name: nameFrom(parties.seller), lines: parties.seller },
    buyer: { name: nameFrom(parties.buyer), lines: parties.buyer },
    identifiers: detectIdentifiers(lines, parties.seller, parties.buyer, flags),
    bankAccounts: detectBankAccounts(lines, flags),
    buyerReference: field(refValue ?? null, refValue ? "medium" : "low"),
    paymentTerms: field(termsValue ?? null, termsValue ? "medium" : "low"),
    lines: detectLines(lines, tableStart, tableEnd),
    totals: detectTotals(
      lines,
      tableEnd === -1 ? tableStart + 1 : tableEnd,
      flags,
      statements.length > 0,
    ),
    statements,
    flags,
  };
  crossCheck(partial, flags);
  return { ...partial, fileSha256, pageCount: pages.length, duplicates: [] };
}
