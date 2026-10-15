/**
 * Locale-tolerant value parsers for imported documents. Each returns `null` when the input
 * cannot be read with certainty, plus an `ambiguous` marker when a reading is possible but not
 * certain. Callers must surface ambiguity to the user instead of guessing silently.
 */

export interface Parsed<T> {
  value: T | null;
  ambiguous: boolean;
}

const CURRENCY_TOKENS = /(€|eur|pln|zł|zl)/gi;

/** Parses "1 234,56", "1,234.56", "1234.56", "12.450,50", "€ 65,00", "-" (none). */
export function parseAmount(input: string): Parsed<string> {
  let s = input
    .replace(CURRENCY_TOKENS, "")
    .replace(/[\s  ]/g, "")
    .trim();
  if (s === "" || /^[-–—]$/.test(s)) return { value: null, ambiguous: false };
  let negative = false;
  if (/^[-–]/.test(s)) {
    negative = true;
    s = s.slice(1);
  } else if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (!/^\d[\d.,']*$/.test(s)) return { value: null, ambiguous: false };
  s = s.replace(/'/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let ambiguous = false;
  let normalized: string;
  if (lastComma === -1 && lastDot === -1) {
    normalized = s;
  } else {
    const decimalSep = lastComma > lastDot ? "," : ".";
    const thousandSep = decimalSep === "," ? "." : ",";
    const decimals = s.length - Math.max(lastComma, lastDot) - 1;
    const sepCount = (s.match(decimalSep === "," ? /,/g : /\./g) ?? []).length;
    if (s.includes(thousandSep) || decimals !== 3 || sepCount > 1) {
      if (sepCount > 1) {
        // "1.234.567" — only thousands separators.
        normalized = s.split(decimalSep).join("").split(thousandSep).join("");
      } else {
        normalized = s.split(thousandSep).join("").replace(decimalSep, ".");
      }
    } else {
      // "1,234" or "1.234": thousands or three decimals? Cannot know.
      ambiguous = true;
      normalized = s.replace(decimalSep, "");
    }
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) return { value: null, ambiguous: false };
  const trimmed = normalized.replace(/^0+(?=\d)/, "");
  return { value: negative && trimmed !== "0" ? `-${trimmed}` : trimmed, ambiguous };
}

export function parseQuantity(input: string): Parsed<string> {
  const s = input.replace(/[\s ]/g, "");
  if (!/^\d+([.,]\d{1,4})?$/.test(s)) return { value: null, ambiguous: false };
  return { value: s.replace(",", ".").replace(/^0+(?=\d)/, ""), ambiguous: false };
}

/** dd.mm.yyyy and yyyy-mm-dd are unambiguous; dd/mm/yyyy may be mm/dd/yyyy. */
export function parseDate(input: string): Parsed<string> & { raw?: string } {
  const iso = input.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return check(iso[1]!, iso[2]!, iso[3]!, false, iso[0]);
  const dotted = input.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (dotted) return check(dotted[3]!, dotted[2]!, dotted[1]!, false, dotted[0]);
  const slashed = input.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slashed) {
    const a = Number(slashed[1]);
    const b = Number(slashed[2]);
    // Read as day/month (European convention); ambiguous if both parts could be a month.
    return check(slashed[3]!, slashed[2]!, slashed[1]!, a <= 12 && b <= 12 && a !== b, slashed[0]);
  }
  return { value: null, ambiguous: false };
}

function check(y: string, m: string, d: string, ambiguous: boolean, raw: string) {
  const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso)
    return { value: null, ambiguous: false };
  return { value: iso, ambiguous, raw };
}

export function findAllDates(text: string): string[] {
  return [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{4}\b/g)].map(
    (m) => m[0],
  );
}
