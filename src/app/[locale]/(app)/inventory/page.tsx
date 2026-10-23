import { type Metadata } from "next";
import { type Locale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CompanyEntry } from "@/components/records/company-entry";
import { documentsEntryData } from "@/server/account/page-data";
import { requirePageUser } from "@/server/auth/page-session";

type Params = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getTranslations({ locale: (await params).locale, namespace: "nav" });
  return { title: t("inventory") };
}

/** "Inventory" in the main navigation: straight to the only company, or a choice of companies. */
export default async function InventoryEntryPage({ params }: Params) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePageUser(locale, "/inventory");
  const t = await getTranslations("nav");
  return (
    <CompanyEntry
      locale={locale}
      title={t("inventory")}
      section="inventory"
      companies={await documentsEntryData(user)}
    />
  );
}
