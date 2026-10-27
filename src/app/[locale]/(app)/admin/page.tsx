import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { type ReactNode } from "react";
import { AccessGrantControls } from "@/components/admin/access-grant-controls";
import { Badge } from "@/components/ui/badge";
import { type AppLocale, LOCALE_FORMAT_TAGS } from "@/i18n/config";
import { requirePageUser } from "@/server/auth/page-session";
import { adminPageData } from "@/server/admin/page-data";

type Params = { params: Promise<{ locale: Locale }> };
type Props = Params & { searchParams: Promise<{ q?: string }> };

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The SaaS operator area. Anyone who is not a platform administrator with a 2FA-verified session
 * gets the ordinary "not found" page: the area does not reveal that it exists.
 */
export default async function AdminPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale);
  const data = await adminPageData(user, (await searchParams).q);
  if (!data) notFound();
  const t = await getTranslations("admin");
  const { overview: o, companies } = data;
  const tag = LOCALE_FORMAT_TAGS[locale as AppLocale];
  const n = (v: number) => new Intl.NumberFormat(tag).format(v);
  const date = (iso: string) =>
    new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  const yes = (b: boolean) => (
    <Badge tone={b ? "success" : "warning"}>{b ? t("on") : t("off")}</Badge>
  );

  return (
    <div className="space-y-8" data-testid="admin">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-text">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted">{t("description")}</p>
      </header>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label={t("users")}
          value={n(o.users.total)}
          note={t("usersNote", { verified: n(o.users.verified), new30: n(o.users.new30) })}
        />
        <Stat
          label={t("companies")}
          value={n(o.companies.total)}
          note={t("new30", { count: o.companies.new30 })}
        />
        <Stat
          label={t("activeSubscriptions")}
          value={n(o.subscriptions.active)}
          note={t("subscriptionsNote", {
            pastDue: o.subscriptions.pastDue,
            canceled: o.subscriptions.canceled,
            failures: o.subscriptions.paymentFailures30d,
          })}
        />
        <Stat
          label={t("listPriceMrr")}
          value={`€${o.subscriptions.monthlyAtListPriceEur}`}
          note={t("listPriceNote")}
        />
        <Stat
          label={t("aiRequests")}
          value={n(o.ai.requestsThisMonth)}
          note={t("aiNote", { companies: o.ai.companies, errors: o.ai.errorsThisMonth })}
        />
        <Stat
          label={t("aiCost")}
          value={`$${o.ai.estimatedCostUsd}`}
          note={t("aiCostNote", { input: n(o.ai.inputTokens), output: n(o.ai.outputTokens) })}
        />
      </ul>
      <section className="space-y-2" aria-labelledby="health">
        <h2 id="health" className="text-xs font-semibold tracking-wider text-muted uppercase">
          {t("health")}
        </h2>
        <div className="flex flex-wrap gap-3 text-sm text-text">
          <span>{t("db", { ms: o.health.dbLatencyMs })}</span>
          <span className="flex items-center gap-1">
            {t("stripe")} {yes(o.health.stripe)}
          </span>
          <span className="flex items-center gap-1">
            {t("webhook")} {yes(o.health.webhook)}
          </span>
          <span className="flex items-center gap-1">
            {t("enforcement")} {yes(o.health.enforcement)}
          </span>
          <span className="flex items-center gap-1">
            {t("ai")} {yes(o.health.ai)}
          </span>
          <span>{t("email", { transport: o.health.email })}</span>
        </div>
      </section>
      <section className="space-y-2" aria-labelledby="companies">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="companies" className="text-xs font-semibold tracking-wider text-muted uppercase">
            {t("companies")}
          </h2>
          <form method="get">
            <label className="sr-only" htmlFor="admin-q">
              {t("search")}
            </label>
            <input
              id="admin-q"
              name="q"
              type="search"
              placeholder={t("search")}
              className="rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm text-text"
            />
          </form>
        </div>
        <div
          className="overflow-x-auto rounded-xl border border-border"
          tabIndex={0}
          role="region"
          aria-label={t("companies")}
        >
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="bg-surface-2 text-left text-xs text-muted">
              <tr>
                {["name", "country", "created", "members", "subscription", "access"].map((c) => (
                  <th key={c} scope="col" className="px-3 py-2 font-medium">
                    {t(`col.${c}` as Parameters<typeof t>[0])}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id} className="border-t border-border">
                  <td className="px-3 py-2 text-text">
                    {c.name}
                    {c.archived ? (
                      <span className="ml-2">
                        <Badge>{t("archived")}</Badge>
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-muted">{c.country}</td>
                  <td className="px-3 py-2 text-muted tabular-nums">{date(c.createdAt)}</td>
                  <td className="px-3 py-2 text-muted tabular-nums">{c.members}</td>
                  <td className="px-3 py-2">
                    {c.status ? (
                      <Badge tone={c.status === "active" ? "success" : "warning"}>{c.status}</Badge>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {c.grantExpiresAt ? (
                      <span className="mr-2 text-xs text-muted">
                        {t("until", { date: date(c.grantExpiresAt) })}
                      </span>
                    ) : null}
                    <AccessGrantControls companyId={c.id} granted={Boolean(c.grantExpiresAt)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="space-y-2" aria-labelledby="events">
        <h2 id="events" className="text-xs font-semibold tracking-wider text-muted uppercase">
          {t("events")}
        </h2>
        <ol className="divide-y divide-border rounded-xl border border-border text-sm">
          {o.events.length === 0 ? <li className="px-4 py-2 text-muted">{t("noEvents")}</li> : null}
          {o.events.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-3 px-4 py-2">
              <code className="text-text">{e.action}</code>
              {e.company ? <span className="text-muted">{e.company}</span> : null}
              <time className="ml-auto text-xs text-muted tabular-nums" dateTime={e.at}>
                {date(e.at)}
              </time>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: ReactNode; note: string }) {
  return (
    <li className="animate-fade-up rounded-2xl p-4 surface-raised">
      <p className="text-sm text-muted">{label}</p>
      <p className="text-2xl font-semibold text-text tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted">{note}</p>
    </li>
  );
}
