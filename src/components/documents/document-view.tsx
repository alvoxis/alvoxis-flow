import { useLocale, useTranslations } from "next-intl";
import { type ReactNode } from "react";
import { type AppLocale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import { type CurrencyCode } from "@/lib/money";
import { type ApiDocument } from "@/features/documents/editor-model";
import { isPricedDocument, type PartySnapshot } from "@/modules/documents/domain/types";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-sm sm:block">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right text-text sm:text-left">{children}</dd>
    </div>
  );
}

function Party({ title, party }: { title: string; party: PartySnapshot }) {
  const t = useTranslations("documentPdf");
  const a = party.address;
  return (
    <div className="space-y-1 text-sm">
      <h3 className="font-semibold text-text">{title}</h3>
      <p className="text-text">{party.name}</p>
      {a ? (
        <p className="text-muted">
          {[...a.lines, [a.postalCode, a.city].filter(Boolean).join(" "), a.countryCode]
            .filter(Boolean)
            .join(", ")}
        </p>
      ) : null}
      {party.registrationNumber ? (
        <p className="text-muted">
          {t("registrationNumber")} {party.registrationNumber}
        </p>
      ) : null}
      {party.vatNumber ? (
        <p className="text-muted">
          {t("vatNumber")} {party.vatNumber}
        </p>
      ) : null}
    </div>
  );
}

/** Read-only presentation of a stored document (issued ones are their frozen snapshot). */
export function DocumentView({ document }: { document: ApiDocument }) {
  const t = useTranslations("documentPdf");
  const locale = useLocale() as AppLocale;
  const d = document.draft;
  const money = (v: string) => formatMoney(v, d.currency as CurrencyCode, locale);
  const priced = isPricedDocument(d.type);
  return (
    <div className="space-y-6" data-testid="document-view">
      <dl className="grid gap-3 sm:grid-cols-4">
        <Row label={t("issueDate")}>{formatDate(d.issueDate, locale)}</Row>
        {d.dueDate ? <Row label={t("dueDate")}>{formatDate(d.dueDate, locale)}</Row> : null}
        {d.supplyDate ? (
          <Row label={t("supplyDate")}>{formatDate(d.supplyDate, locale)}</Row>
        ) : null}
        {d.validUntil ? (
          <Row label={t("validUntil")}>{formatDate(d.validUntil, locale)}</Row>
        ) : null}
        {d.buyerReference ? <Row label={t("buyerReference")}>{d.buyerReference}</Row> : null}
      </dl>
      <div className="grid gap-4 sm:grid-cols-2">
        <Party title={t("seller")} party={d.seller} />
        <Party title={t("buyer")} party={d.buyer} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm" data-testid="document-lines">
          <thead className="text-left text-xs text-muted uppercase">
            <tr className="border-b border-border">
              <th className="py-2 pr-2 font-medium">{t("lineNo")}</th>
              <th className="py-2 pr-2 font-medium">{t("description")}</th>
              <th className="py-2 pr-2 text-right font-medium">{t("quantity")}</th>
              {priced ? (
                <>
                  <th className="py-2 pr-2 text-right font-medium">{t("unitPrice")}</th>
                  <th className="py-2 pr-2 text-right font-medium">{t("tax")}</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {d.lines.map((l, i) => (
              <tr key={l.id}>
                <td className="py-2 pr-2 text-muted">{i + 1}</td>
                <td className="py-2 pr-2 text-text">{l.description}</td>
                <td className="py-2 pr-2 text-right text-text">
                  {l.quantity} {l.unit ?? ""}
                </td>
                {priced ? (
                  <>
                    <td className="py-2 pr-2 text-right text-text">
                      {l.unitPrice ? money(l.unitPrice) : "—"}
                    </td>
                    <td className="py-2 pr-2 text-right text-muted">
                      {l.taxCategory?.label ?? "—"}
                    </td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {document.totals ? <Totals totals={document.totals} currency={d.currency} /> : null}
      {d.paymentTerms || d.notes ? (
        <dl className="grid gap-3 sm:grid-cols-2">
          {d.paymentTerms ? <Row label={t("paymentTerms")}>{d.paymentTerms}</Row> : null}
          {d.notes ? <Row label={t("notes")}>{d.notes}</Row> : null}
        </dl>
      ) : null}
    </div>
  );
}

/** Server-calculated totals; the UI never computes amounts itself. */
export function Totals({
  totals,
  currency,
}: {
  totals: NonNullable<ApiDocument["totals"]>;
  currency: string;
}) {
  const t = useTranslations("documentPdf");
  const locale = useLocale() as AppLocale;
  const money = (v: string) => formatMoney(v, currency as CurrencyCode, locale);
  return (
    <dl className="ml-auto max-w-xs space-y-1 text-sm" data-testid="document-totals">
      <div className="flex justify-between gap-4">
        <dt className="text-muted">{t("netTotal")}</dt>
        <dd className="text-text">{money(totals.netTotal)}</dd>
      </div>
      <div className="flex justify-between gap-4">
        <dt className="text-muted">{t("taxTotal")}</dt>
        <dd className="text-text">{money(totals.taxTotal)}</dd>
      </div>
      <div className="flex justify-between gap-4 font-semibold">
        <dt className="text-text">{t("grossTotal")}</dt>
        <dd className="text-text" data-testid="document-gross-total">
          {money(totals.grossTotal)}
        </dd>
      </div>
    </dl>
  );
}
