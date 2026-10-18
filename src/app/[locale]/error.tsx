"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

/**
 * Error boundary for every localized page. It never shows the error message or stack (they can
 * contain internal details); only the digest, which matches the server log entry.
 */
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errorPage");
  return (
    <main
      role="alert"
      data-testid="error-page"
      className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <h1 className="text-2xl font-semibold text-text">{t("title")}</h1>
      <p className="max-w-md text-muted">{t("description")}</p>
      {error.digest ? (
        <p className="text-xs text-muted" data-testid="error-digest">
          {t("digest", { digest: error.digest })}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-white hover:bg-violet-700"
        >
          {t("retry")}
        </button>
        <Link
          href="/"
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text hover:bg-surface-2"
        >
          {t("home")}
        </Link>
      </div>
    </main>
  );
}
