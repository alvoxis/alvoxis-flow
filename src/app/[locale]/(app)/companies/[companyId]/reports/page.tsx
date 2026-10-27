import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/form";
import { parseRange, RANGE_PRESETS } from "@/features/dashboard/range";
import { type AppLocale, LOCALE_FORMAT_TAGS } from "@/i18n/config";
import { Link } from "@/i18n/navigation";
import { formatDate } from "@/lib/format";
import { requirePageUser } from "@/server/auth/page-session";
import { reportsPageData } from "@/server/reports/page-data";

type Params = { params: Promise<{ locale: Locale; companyId: string }> };
type Props = Params & {
  searchParams: Promise<{ view?: string; range?: string; from?: string; to?: string }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "reports" });
  return { title: t("title") };
}

/** Reports of a company for a period, each with a CSV export of exactly what is shown. */
export default async function ReportsPage({ params, searchParams }: Props) {
  const { locale, companyId } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const sp = await searchParams;
  const range = parseRange(
    { range: sp.range ?? "this_year", from: sp.from, to: sp.to },
    new Date().toISOString().slice(0, 10),
  );
  const data = await reportsPageData(user, companyId, sp.view, range);
  if (data.status === "not_found") notFound();
  const t = await getTranslations("reports");
  const tCompany = await getTranslations("company");
  const tFin = await getTranslations("finance");
  if (data.status === "two_factor_required")
    return (
      <Alert tone="warning">
        {tCompany("twoFactorRequired")}{" "}
        <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
      </Alert>
    );
  const tag = LOCALE_FORMAT_TAGS[locale as AppLocale];
  const base = `/companies/${companyId}/reports`;
  const rangeQs =
    range.preset === "custom"
      ? `range=custom&from=${range.from}&to=${range.to}`
      : `range=${range.preset}`;
  const report = data.report;
  const numeric = new Set(report?.numeric ?? []);
  const num = (v: string) => {
    if (v === "" || Number.isNaN(Number(v))) return v;
    const digits = v.includes(".") ? v.split(".")[1]!.length : 0;
    return new Intl.NumberFormat(tag, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(v as Intl.StringNumericLiteral);
  };
  const cell = (col: string, v: string) => {
    if (numeric.has(col)) return num(v);
    if (col === "category" && v !== "total")
      return tFin(`category.${v}` as Parameters<typeof tFin>[0]);
    if (col === "ageing" && v) return t(`ageing.${v}` as Parameters<typeof t>[0]);
    if (v === "total" || v === "balance") return t(`row.${v}`);
    if (col === "direction") return t(`direction.${v}` as Parameters<typeof t>[0]);
    if (col === "treatment" && v) return t(`treatment.${v}` as Parameters<typeof t>[0]);
    return v;
  };

  return (
    <Card>
      <CardHeader
        title={t("title")}
        description={t("period", {
          from: formatDate(range.from, locale as AppLocale),
          to: formatDate(range.to, locale as AppLocale),
        })}
      />
      {data.available.length === 0 ? (
        <Alert tone="info">{t("none")}</Alert>
      ) : (
        <div className="space-y-5" data-testid="reports">
          <nav aria-label={t("choose")} className="flex flex-wrap gap-2">
            {data.available.map((r) => (
              <Link
                key={r}
                href={`${base}?view=${r}&${rangeQs}`}
                aria-current={data.current === r ? "page" : undefined}
                data-testid={`report-tab-${r}`}
                className={`inline-flex min-h-10 items-center rounded-full border px-3.5 text-sm ${data.current === r ? "border-accent bg-accent-soft text-text" : "border-border text-muted hover:text-text"}`}
              >
                {t(`name.${r}`)}
              </Link>
            ))}
          </nav>
          <div className="flex flex-wrap items-end gap-2">
            {RANGE_PRESETS.filter((p) => p !== "custom").map((p) => (
              <Link
                key={p}
                href={`${base}?view=${data.current}&range=${p}`}
                aria-current={range.preset === p ? "page" : undefined}
                className={`rounded-full px-3 py-1.5 text-xs ${range.preset === p ? "bg-surface-2 text-text" : "text-muted hover:text-text"}`}
              >
                {t(`range.${p}`)}
              </Link>
            ))}
            <form method="get" className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="view" value={data.current ?? ""} />
              <input type="hidden" name="range" value="custom" />
              <label className="text-xs text-muted">
                {t("from")}
                <input
                  type="date"
                  name="from"
                  defaultValue={range.from}
                  required
                  className="mt-1 block rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm text-text"
                />
              </label>
              <label className="text-xs text-muted">
                {t("to")}
                <input
                  type="date"
                  name="to"
                  defaultValue={range.to}
                  required
                  className="mt-1 block rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm text-text"
                />
              </label>
              <button
                type="submit"
                className="rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm text-text"
              >
                {t("apply")}
              </button>
            </form>
            {report ? (
              <a
                href={`/api/companies/${companyId}/reports/${report.id}?${rangeQs}&format=csv`}
                className="ml-auto text-sm text-accent hover:underline"
                data-testid="report-csv"
              >
                {t("csv")}
              </a>
            ) : null}
          </div>
          {report ? (
            <>
              <p className="text-sm text-muted">{t(`note.${report.id}`)}</p>
              {report.rows.length === 0 ? (
                <p
                  className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted"
                  data-testid="report-empty"
                >
                  {t("empty")}
                </p>
              ) : (
                <div
                  className="overflow-x-auto rounded-xl border border-border"
                  tabIndex={0}
                  role="region"
                  aria-label={t(`name.${report.id}`)}
                >
                  <table className="w-full min-w-[40rem] text-sm" data-testid="report-table">
                    <thead className="bg-surface-2 text-xs text-muted">
                      <tr>
                        {report.columns.map((c) => (
                          <th
                            key={c}
                            scope="col"
                            className={`px-3 py-2 font-medium ${numeric.has(c) ? "text-right" : "text-left"}`}
                          >
                            {t(`col.${c}` as Parameters<typeof t>[0])}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {report.rows.map((row, i) => (
                        <tr key={i} className="border-t border-border">
                          {row.map((v, j) => (
                            <td
                              key={j}
                              className={`px-3 py-2 text-text ${numeric.has(report.columns[j]!) ? "text-right" : ""}`}
                            >
                              {cell(report.columns[j]!, v)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                    {report.totals.length ? (
                      <tfoot className="border-t-2 border-border font-semibold tabular-nums">
                        {report.totals.map((row, i) => (
                          <tr key={i}>
                            {row.map((v, j) => (
                              <td
                                key={j}
                                className={`px-3 py-2 text-text ${numeric.has(report.columns[j]!) ? "text-right" : ""}`}
                              >
                                {cell(report.columns[j]!, v)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tfoot>
                    ) : null}
                  </table>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </Card>
  );
}
