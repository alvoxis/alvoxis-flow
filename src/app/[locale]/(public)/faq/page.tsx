import { type Metadata } from "next";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FaqList } from "@/components/public/faq-list";
import { publicMetadata } from "@/components/public/metadata";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return publicMetadata((await params).locale, "faq", "/faq");
}

export default async function FaqPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("public.faq");
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="text-4xl font-semibold tracking-tight text-text">{t("title")}</h1>
      <div className="mt-8">
        <FaqList />
      </div>
    </div>
  );
}
