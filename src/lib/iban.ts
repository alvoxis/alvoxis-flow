/**
 * IBAN structural check (ISO 13616 mod-97). This verifies the checksum only — it does not prove the
 * account exists or belongs to anyone.
 */
export function normalizeIban(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

export function isValidIban(input: string): boolean {
  const iban = normalizeIban(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

/** Shows only the country code and last four characters, e.g. "LV•• •••• 5001". */
export function maskIban(input: string): string {
  const iban = normalizeIban(input);
  if (iban.length < 8) return "••••";
  return `${iban.slice(0, 2)}•• •••• ${iban.slice(-4)}`;
}
