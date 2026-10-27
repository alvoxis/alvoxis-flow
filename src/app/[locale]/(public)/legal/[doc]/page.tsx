import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { publicMetadata } from "@/components/public/metadata";
import { Link } from "@/i18n/navigation";
import { type AppLocale, LOCALES } from "@/i18n/config";

/** Legal drafts and how many sections each has (texts in messages: public.legal.<doc>.sN). */
const DOCS = { privacy: 9, terms: 9, subscription: 7, cookies: 4 } as const;
type Doc = keyof typeof DOCS;

type Params = { params: Promise<{ locale: Locale; doc: string }> };

export function generateStaticParams() {
  return LOCALES.flatMap((locale) => Object.keys(DOCS).map((doc) => ({ locale, doc })));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale, doc } = await params;
  if (!(doc in DOCS)) return {};
  return publicMetadata(locale as AppLocale, doc as Doc, `/legal/${doc}`);
}

/**
 * Privacy policy, terms of service, subscription terms and cookie notice. They describe what the
 * application actually does; they are DRAFTS that must be reviewed by a lawyer and completed with
 * the operator's legal details before commercial launch, and say so at the top.
 */
export default async function LegalPage({ params }: Params) {
  const { locale, doc } = await params;
  if (!(doc in DOCS)) notFound();
  setRequestLocale(locale);
  const d = doc as Doc;
  const t = await getTranslations("public.legal");
  return (
    <article className="mx-auto max-w-3xl px-4 py-14 sm:px-6" data-testid={`legal-${d}`}>
      <p
        role="note"
        className="mb-6 rounded-xl border border-warning/50 bg-warning/10 px-4 py-3 text-sm text-text"
        data-testid="legal-draft"
      >
        {t("draftNotice")}
      </p>
      <h1 className="text-4xl font-semibold tracking-tight text-text">{t(`${d}.title`)}</h1>
      <p className="mt-4 text-muted">{t(`${d}.intro`)}</p>
      {Array.from({ length: DOCS[d] }, (_, i) => i + 1).map((n) => (
        <section key={n} className="mt-8" aria-labelledby={`s${n}`}>
          <h2 id={`s${n}`} className="text-lg font-semibold text-text">
            {t(`${d}.s${n}.title` as Parameters<typeof t>[0])}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            {t(`${d}.s${n}.body` as Parameters<typeof t>[0])}
          </p>
        </section>
      ))}
      <nav
        aria-label={t("other")}
        className="mt-12 flex flex-wrap gap-3 border-t border-border pt-6 text-sm"
      >
        {(Object.keys(DOCS) as Doc[])
          .filter((x) => x !== d)
          .map((x) => (
            <Link key={x} href={`/legal/${x}`} className="text-accent hover:underline">
              {t(`${x}.title`)}
            </Link>
          ))}
      </nav>
    </article>
  );
}
