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
  backQuery = "",
  filtered = false,
}: {
  companyId: string;
  rows: DocumentListRow[];
  canDelete: boolean;
  /** The list's query string ("?q=…"), so a document's back link returns to the same view. */
  backQuery?: string;
  /** Search or filters are active: an empty result means "nothing found", not "no documents". */
  filtered?: boolean;
}) {
  const t = useTranslations("documents");
  const tType = useTranslations("documentPdf.title");
  const locale = useLocale() as AppLocale;
  if (rows.length === 0)
    return filtered ? (
      <div className="space-y-2 py-6 text-center" data-testid="documents-no-matches">
        <p className="text-sm text-text">{t("filters.noMatches")}</p>
        <Link
          href={`/companies/${companyId}/documents`}
          className="inline-flex min-h-11 items-center text-sm text-violet-300 hover:underline"
        >
          {t("filters.reset")}
        </Link>
      </div>
    ) : (
      <p className="text-sm text-muted" data-testid="documents-empty">
        {t("empty")}
      </p>
    );
  const back = backQuery ? `?back=${encodeURIComponent(backQuery.slice(1))}` : "";
  return (
    <div>
      <div className="hidden grid-cols-[1.1fr_1.6fr_1fr_0.9fr_0.9fr_1fr] gap-3 border-b border-border px-1 pb-2 text-xs font-medium tracking-wide text-muted uppercase lg:grid">
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
              href={`/companies/${companyId}/documents/${d.id}${back}`}
              className="grid grid-cols-2 gap-x-3 gap-y-1 px-1 py-3 text-sm hover:bg-surface-2/60 lg:grid-cols-[1.1fr_1.6fr_1fr_0.9fr_0.9fr_1fr] lg:items-center"
            >
              <span
                className="font-medium whitespace-nowrap text-text"
                data-testid="document-number"
              >
                {d.number ?? <span className="text-muted">{t("notIssued")}</span>}
              </span>
              <span className="text-right text-muted lg:order-2 lg:text-left">{tType(d.type)}</span>
              {/* Long names are cut with an ellipsis; the full name is in the title and the
                  accessible text (and on the document page). */}
              <span
                className="col-span-2 min-w-0 truncate text-text lg:order-1 lg:col-span-1"
                title={d.buyerName?.trim() ? d.buyerName : undefined}
                data-testid="document-buyer"
              >
                {d.buyerName?.trim() ? d.buyerName : "—"}
              </span>
              <span className="lg:order-3">
                <DocumentStatusBadge status={d.status} />
              </span>
              <span className="text-right text-muted lg:order-4 lg:text-left">
                {formatDate(d.issueDate, locale)}
              </span>
              <span className="col-span-2 text-right font-medium text-text lg:order-5 lg:col-span-1">
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
