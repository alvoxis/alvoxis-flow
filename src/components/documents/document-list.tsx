import { useLocale, useTranslations } from "next-intl";
import { DocumentStatusBadge } from "@/components/documents/document-status-badge";
import { Link } from "@/i18n/navigation";
import { type AppLocale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import { type CurrencyCode } from "@/lib/money";

export interface DocumentListRow {
  id: string;
  type: "invoice" | "proforma" | "credit_note" | "delivery_note";
  status: "draft" | "issued";
  number: string | null;
  issueDate: string;
  currency: string;
  grossTotal: string | null;
}

/** Rows as returned by the list API; the stored total exists only for issued documents. */
export function DocumentList({ companyId, rows }: { companyId: string; rows: DocumentListRow[] }) {
  const t = useTranslations("documents");
  const tType = useTranslations("documentPdf.title");
  const locale = useLocale() as AppLocale;
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted" data-testid="documents-empty">
        {t("empty")}
      </p>
    );
  return (
    <div>
      <div className="hidden grid-cols-[1.2fr_1.2fr_1fr_1fr_1fr] gap-3 border-b border-border px-1 pb-2 text-xs font-medium tracking-wide text-muted uppercase md:grid">
        <span>{t("colNumber")}</span>
        <span>{t("colType")}</span>
        <span>{t("colStatus")}</span>
        <span>{t("colIssueDate")}</span>
        <span className="text-right">{t("colTotal")}</span>
      </div>
      <ul className="divide-y divide-border" data-testid="document-list">
        {rows.map((d) => (
          <li key={d.id} data-testid="document-row" data-document-id={d.id}>
            <Link
              href={`/companies/${companyId}/documents/${d.id}`}
              className="grid grid-cols-2 gap-x-3 gap-y-1 px-1 py-3 text-sm hover:bg-surface-2/60 md:grid-cols-[1.2fr_1.2fr_1fr_1fr_1fr] md:items-center"
            >
              <span className="font-medium text-text" data-testid="document-number">
                {d.number ?? <span className="text-muted">{t("notIssued")}</span>}
              </span>
              <span className="text-right text-muted md:order-none md:text-left">
                {tType(d.type)}
              </span>
              <span>
                <DocumentStatusBadge status={d.status} />
              </span>
              <span className="text-right text-muted md:text-left">
                {formatDate(d.issueDate, locale)}
              </span>
              <span className="col-span-2 text-right font-medium text-text md:col-span-1">
                {d.grossTotal ? formatMoney(d.grossTotal, d.currency as CurrencyCode, locale) : "—"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
