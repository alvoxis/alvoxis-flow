"use client";

import { usePathname } from "next/navigation";
import { localeOfPath } from "@/features/errors/locale";
import { type AppLocale } from "@/i18n/config";

/**
 * Last-resort boundary when the localized layout itself fails: no message catalogs or providers
 * are available here, so the few texts are inlined. Shows only the digest, never error details.
 */
const TEXT: Record<
  AppLocale,
  { title: string; description: string; digest: string; retry: string; home: string }
> = {
  en: {
    title: "Something went wrong",
    description: "The page could not be shown. Please try again.",
    digest: "Error code:",
    retry: "Try again",
    home: "Back to the dashboard",
  },
  ru: {
    title: "Что-то пошло не так",
    description: "Не удалось показать страницу. Попробуйте ещё раз.",
    digest: "Код ошибки:",
    retry: "Повторить",
    home: "Вернуться к обзору",
  },
  lv: {
    title: "Radās kļūda",
    description: "Lapu neizdevās parādīt. Lūdzu, mēģiniet vēlreiz.",
    digest: "Kļūdas kods:",
    retry: "Mēģināt vēlreiz",
    home: "Atpakaļ uz pārskatu",
  },
  lt: {
    title: "Įvyko klaida",
    description: "Puslapio nepavyko parodyti. Bandykite dar kartą.",
    digest: "Klaidos kodas:",
    retry: "Bandyti dar kartą",
    home: "Grįžti į apžvalgą",
  },
  et: {
    title: "Midagi läks valesti",
    description: "Lehte ei õnnestunud kuvada. Palun proovige uuesti.",
    digest: "Veakood:",
    retry: "Proovi uuesti",
    home: "Tagasi ülevaatesse",
  },
};

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const locale = localeOfPath(usePathname());
  const t = TEXT[locale];
  return (
    <html lang={locale}>
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "0 1.5rem",
          textAlign: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#0b0a10",
          color: "#ece9f5",
        }}
      >
        <main role="alert" data-testid="global-error-page">
          <h1 style={{ fontSize: "1.5rem" }}>{t.title}</h1>
          <p>{t.description}</p>
          {error.digest ? (
            <p style={{ fontSize: "0.75rem", opacity: 0.7 }}>
              {t.digest} {error.digest}
            </p>
          ) : null}
          <p style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
            <button type="button" onClick={() => reset()}>
              {t.retry}
            </button>
            <a href={`/${locale}`}>{t.home}</a>
          </p>
        </main>
      </body>
    </html>
  );
}
