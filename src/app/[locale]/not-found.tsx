import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

export default function LocaleNotFound() {
  const t = useTranslations("notFound");
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="font-mono text-sm text-accent">404</p>
      <h1 className="text-2xl font-semibold text-text">{t("title")}</h1>
      <p className="max-w-md text-muted">{t("description")}</p>
      <Link
        href="/"
        className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-white hover:bg-accent"
      >
        {t("backHome")}
      </Link>
    </main>
  );
}
