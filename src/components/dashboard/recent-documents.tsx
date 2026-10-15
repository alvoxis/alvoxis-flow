import { useLocale, useTranslations } from "next-intl";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { type DocumentSummary } from "@/features/dashboard/types";
import { formatDate, formatMoney } from "@/lib/format";
import { StatusBadge } from "./status-badge";

export function RecentDocuments({ documents }: { documents: readonly DocumentSummary[] }) {
  const t = useTranslations("dashboard.recent");
  const tType = useTranslations("documentType");
  const tDash = useTranslations("dashboard");
  const locale = useLocale();

  const amount = (d: DocumentSummary) =>
    d.total === null ? (
      <span className="text-muted" title={t("noAmount")}>
        —<span className="sr-only">{t("noAmount")}</span>
      </span>
    ) : (
      <span className={d.total.startsWith("-") ? "text-danger" : undefined}>
        {formatMoney(d.total, d.currency, locale)}
      </span>
    );

  return (
    <Card padded={false}>
      <div className="px-5 pt-5">
        <CardHeader
          title={t("title")}
          description={t("description")}
          action={<Badge tone="warning">{tDash("demoBadge")}</Badge>}
        />
      </div>

      {/* Desktop / tablet: table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm" data-testid="recent-documents-table">
          <thead>
            <tr className="border-y border-border bg-surface-2/60 text-xs tracking-wide text-muted uppercase">
              <th scope="col" className="px-4 py-3 font-medium">
                {t("number")} / {t("type")}
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                {t("customer")}
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                {t("date")}
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                {t("status")}
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                {t("amount")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {documents.map((d) => (
              <tr key={d.id} className="transition-colors hover:bg-surface-2/50">
                <td className="px-4 py-3 whitespace-nowrap">
                  <div className="font-mono text-[13px] text-text">{d.number}</div>
                  <div className="text-xs text-muted">{tType(d.type)}</div>
                  {d.creditsDocumentNumber ? (
                    <div className="text-xs text-muted/80">
                      {t("creditsInvoice", { number: d.creditsDocumentNumber })}
                    </div>
                  ) : null}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-text">{d.customer}</td>
                <td className="tabular px-4 py-3 whitespace-nowrap text-muted">
                  <time dateTime={d.issueDate}>{formatDate(d.issueDate, locale)}</time>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={d.status} />
                </td>
                <td className="tabular px-4 py-3 text-right font-medium whitespace-nowrap">
                  {amount(d)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: stacked list */}
      <ul className="divide-y divide-border border-t border-border md:hidden">
        {documents.map((d) => (
          <li key={d.id} className="flex items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="font-mono text-[13px] text-text">{d.number}</p>
              <p className="truncate text-sm text-muted">
                {tType(d.type)} · {d.customer}
              </p>
              <p className="tabular text-xs text-muted">
                <time dateTime={d.issueDate}>{formatDate(d.issueDate, locale)}</time>
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="tabular text-sm font-medium">{amount(d)}</span>
              <StatusBadge status={d.status} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
