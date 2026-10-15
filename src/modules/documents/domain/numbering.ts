/**
 * Document numbering series. A series has a pattern made of literal text and tokens:
 *   {seq}      sequence number            {seq:4}  zero-padded to 4 digits
 *   {yyyy}     issue year (4 digits)      {yy}     issue year (2 digits)
 *   {mm}       issue month (2 digits)
 * Examples: "{seq:2}/{yyyy}" → "01/2025", "INV-{yyyy}-{seq:4}" → "INV-2025-0001".
 *
 * Numbers are allocated only when a document is issued (drafts have no number), inside the issuing
 * transaction, so failed issues do not consume numbers.
 */
export type NumberingResetPolicy = "never" | "yearly";

export interface NumberingSeriesConfig {
  pattern: string;
  resetPolicy: NumberingResetPolicy;
}

const TOKEN = /\{([^{}]*)\}/g;
const KNOWN = /^(seq(:\d{1,2})?|yyyy|yy|mm)$/;
export const MAX_NUMBER_LENGTH = 40;

export function validateNumberingPattern(config: NumberingSeriesConfig): string[] {
  const errors: string[] = [];
  const tokens = [...config.pattern.matchAll(TOKEN)].map((m) => m[1] ?? "");
  const unknown = tokens.filter((t) => !KNOWN.test(t));
  if (unknown.length) errors.push(`Unknown token(s): ${unknown.map((t) => `{${t}}`).join(", ")}`);
  const seqCount = tokens.filter((t) => t.startsWith("seq")).length;
  if (seqCount !== 1) errors.push("Pattern must contain exactly one {seq} token");
  if (config.resetPolicy === "yearly" && !tokens.some((t) => t === "yyyy" || t === "yy")) {
    errors.push("A yearly series must include {yyyy} or {yy}, otherwise numbers would repeat");
  }
  const literal = config.pattern.replace(TOKEN, "");
  if (/[{}]/.test(literal)) errors.push("Unbalanced braces in pattern");
  if (/[^\p{L}\p{N}\-/._ #]/u.test(literal)) errors.push("Pattern contains unsupported characters");
  if (config.pattern.length > MAX_NUMBER_LENGTH) errors.push("Pattern is too long");
  return errors;
}

/** Counter bucket: one per year for yearly series, a single bucket otherwise. */
export function numberingPeriodKey(config: NumberingSeriesConfig, issueDate: string): string {
  return config.resetPolicy === "yearly" ? issueDate.slice(0, 4) : "all";
}

export function formatDocumentNumber(pattern: string, sequence: number, issueDate: string): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new Error("Sequence must be a positive integer");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) throw new Error(`Invalid issue date ${issueDate}`);
  const [yyyy, mm] = issueDate.split("-") as [string, string];
  return pattern.replace(TOKEN, (_, token: string) => {
    if (token === "yyyy") return yyyy;
    if (token === "yy") return yyyy.slice(2);
    if (token === "mm") return mm;
    if (token.startsWith("seq")) {
      const width = Number(token.split(":")[1] ?? 0);
      return String(sequence).padStart(width, "0");
    }
    throw new Error(`Unknown token {${token}}`);
  });
}
