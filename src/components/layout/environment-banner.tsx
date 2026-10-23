import { getTranslations } from "next-intl/server";
import { isTestEnvironment } from "@/config/environment-mode";

/**
 * A strip at the very top of every page of a test deployment (Vercel preview or APP_TEST_MODE=1):
 * nothing there is production data, and only synthetic data may be entered. Renders nothing in
 * production.
 */
export async function EnvironmentBanner() {
  if (!isTestEnvironment()) return null;
  const t = await getTranslations("environment");
  return (
    <div
      role="note"
      aria-label={t("label")}
      data-testid="test-environment-banner"
      className="border-b border-warning/40 bg-amber-950 px-4 py-1.5 text-center text-xs font-medium text-amber-100 sm:text-sm"
    >
      <span className="mr-2 rounded bg-warning px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-black uppercase">
        {t("label")}
      </span>
      {t("testBanner")}
    </div>
  );
}
