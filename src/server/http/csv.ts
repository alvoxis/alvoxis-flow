/**
 * CSV for spreadsheet programs used in the Baltics and Poland: semicolon-separated, CRLF, UTF-8
 * with BOM. Every text cell is quoted, and a leading = + - @ (or tab/CR) is neutralised so a cell
 * can never run as a spreadsheet formula. Numbers are written as plain decimal strings.
 */
export function csvText(v: string | null | undefined): string {
  const s = v ?? "";
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
}

export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return `﻿${[header.join(";"), ...rows.map((r) => r.join(";"))].join("\r\n")}\r\n`;
}

export function csvResponse(filename: string, body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "cache-control": "no-store",
    },
  });
}
