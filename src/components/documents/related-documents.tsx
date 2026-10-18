import { useLocale, useTranslations } from "next-intl";
import { type DocumentListRow } from "@/components/documents/document-list";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/form";
import { type AppLocale } from "@/i18n/config";
import { Link } from "@/i18n/navigation";
import { formatDate, formatMoney } from "@/lib/format";
import { type CurrencyCode } from "@/lib/money";
import { type DocumentRelation } from "@/modules/documents/domain/types";

/**
 * The credit notes of an issued invoice: number (or "not issued yet"), status, date and total,
 * each opening the credit note. A table from `md`, cards on phones. Drafts are visibly different
 * (badge, muted, dashed border on phones). `items === null` means the list could not be loaded:
 * the invoice stays usable and a notice says so.
 */
export function RelatedCreditNotes({
  companyId,
  items,
}: {
  companyId: string;
  items: DocumentListRow[] | null;
}) {
  const t = useTranslations("documents");
  const locale = useLocale() as AppLocale;
  return (
    <section
      aria-labelledby="related-credit-notes"
      className="space-y-2"
      data-testid="related-credit-notes"
    >
      <h3 id="related-credit-notes" className="text-sm font-semibold text-text">
        {t("related.creditNotesTitle")}
      </h3>
      {items === null ? (
        <Alert tone="warning">
          <span data-testid="related-credit-notes-error">{t("related.loadError")}</span>
        </Alert>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted" data-testid="related-credit-notes-empty">
          {t("related.empty")}
        </p>
      ) : (
        <ul className="space-y-2 md:space-y-0 md:divide-y md:divide-border md:border-y md:border-border">
          {items.map((d) => {
            const draft = d.status === "draft";
            const label = d.number ?? t("notIssued");
            return (
              <li key={d.id} data-testid="related-credit-note" data-status={d.status}>
                <Link
                  href={`/companies/${companyId}/documents/${d.id}`}
                  className={`grid min-h-11 grid-cols-2 items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2.5 text-sm hover:bg-surface-2/60 md:grid-cols-[1.2fr_1fr_1fr_1fr] md:rounded-none md:border-0 md:px-1 ${draft ? "border-dashed border-border text-muted" : "border-border text-text"}`}
                >
                  <span className={draft ? "italic" : "font-medium"}>{label}</span>
                  <span className="justify-self-end md:justify-self-start">
                    <Badge tone={draft ? "neutral" : "success"}>{t(`status.${d.status}`)}</Badge>
                  </span>
                  <span className="text-muted">{formatDate(d.issueDate, locale)}</span>
                  <span className="tabular text-right">
                    {d.grossTotal
                      ? formatMoney(d.grossTotal, d.currency as CurrencyCode, locale)
                      : "—"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The document this one refers to (e.g. the invoice a credit note corrects), from the document's
 * own relation, with a link to it. The linked page checks access again.
 */
export function DocumentRelationLink({
  companyId,
  relation,
}: {
  companyId: string;
  relation: DocumentRelation;
}) {
  const t = useTranslations("documents.relation");
  const locale = useLocale() as AppLocale;
  return (
    <p
      className="rounded-lg border border-accent/40 bg-accent-soft/40 px-3 py-2.5 text-sm text-text"
      data-testid="document-relation"
      data-related-id={relation.documentId}
    >
      {t.rich(relation.kind, {
        number: relation.documentNumber,
        date: formatDate(relation.issueDate, locale),
        link: (chunks) => (
          <Link
            href={`/companies/${companyId}/documents/${relation.documentId}`}
            className="font-medium text-violet-300 underline-offset-2 hover:underline"
            data-testid="document-relation-link"
          >
            {chunks}
          </Link>
        ),
      })}
    </p>
  );
}
