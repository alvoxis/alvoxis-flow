import { type Metadata } from "next";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { publicMetadata } from "@/components/public/metadata";
import { Link } from "@/i18n/navigation";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return publicMetadata((await params).locale, "contact", "/contact");
}

/** Contact: the address the operator configures (CONTACT_EMAIL); nothing is invented without it. */
export default async function ContactPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("public.contact");
  const email = process.env.CONTACT_EMAIL?.trim();
  const valid = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  return (
    <div className="mx-auto max-w-2xl px-4 py-14 sm:px-6">
      <h1 className="text-4xl font-semibold tracking-tight text-text">{t("title")}</h1>
      <p className="mt-4 text-muted">{t("text")}</p>
      <div className="mt-8 rounded-2xl p-6 surface-raised" data-testid="contact">
        {valid ? (
          <p className="text-text">
            {t("emailLabel")}{" "}
            <a href={`mailto:${valid}`} className="font-medium text-accent hover:underline">
              {valid}
            </a>
          </p>
        ) : (
          <p className="text-muted">{t("notPublished")}</p>
        )}
      </div>
      <p className="mt-6 text-sm text-muted">
        {t("customers")}{" "}
        <Link href="/sign-in" className="text-accent hover:underline">
          {t("signIn")}
        </Link>
      </p>
    </div>
  );
}
