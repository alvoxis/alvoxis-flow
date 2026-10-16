import { useLocale, useTranslations } from "next-intl";
import { DeleteDraftButton } from "@/components/documents/delete-draft-button";
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
  buyerName: string | null;
  grossTotal: string | null;
}

/**
 * Rows as returned by the list API; the stored total exists only for issued documents. Drafts get
 * a delete action for users with documents.create (`canDelete`); issued documents never do.
 */
export function DocumentList({
  companyId,
  rows,
  canDelete,
}: {
  companyId: string;
  rows: DocumentListRow[];
  canDelete: boolean;
}) {
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
      <div className="hidden grid-cols-[1.1fr_1.6fr_1fr_0.9fr_0.9fr_1fr] gap-3 border-b border-border px-1 pb-2 text-xs font-medium tracking-wide text-muted uppercase md:grid">
        <span>{t("colNumber")}</span>
        <span>{t("colBuyer")}</span>
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
              className="grid grid-cols-2 gap-x-3 gap-y-1 px-1 py-3 text-sm hover:bg-surface-2/60 md:grid-cols-[1.1fr_1.6fr_1fr_0.9fr_0.9fr_1fr] md:items-center"
            >
              <span className="font-medium text-text" data-testid="document-number">
                {d.number ?? <span className="text-muted">{t("notIssued")}</span>}
              </span>
              <span className="text-right text-muted md:order-2 md:text-left">{tType(d.type)}</span>
              {/* Long names are cut with an ellipsis; the full name is in the title and the
                  accessible text (and on the document page). */}
              <span
                className="col-span-2 min-w-0 truncate text-text md:order-1 md:col-span-1"
                title={d.buyerName?.trim() ? d.buyerName : undefined}
                data-testid="document-buyer"
              >
                {d.buyerName?.trim() ? d.buyerName : "—"}
              </span>
              <span className="md:order-3">
                <DocumentStatusBadge status={d.status} />
              </span>
              <span className="text-right text-muted md:order-4 md:text-left">
                {formatDate(d.issueDate, locale)}
              </span>
              <span className="col-span-2 text-right font-medium text-text md:order-5 md:col-span-1">
                {d.grossTotal ? formatMoney(d.grossTotal, d.currency as CurrencyCode, locale) : "—"}
              </span>
            </Link>
            {canDelete && d.status === "draft" ? (
              <div className="px-1 pb-3">
                <DeleteDraftButton companyId={companyId} documentId={d.id} compact />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
