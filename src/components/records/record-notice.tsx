"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/form";
import { type RecordOutcome } from "@/features/records/api";
import { Link } from "@/i18n/navigation";

/** What a record page tells the user after an action: a success text or a classified failure. */
export type RecordNoticeState =
  { kind: "done"; message: string } | Exclude<RecordOutcome<unknown>, { kind: "ok" }>;

/**
 * The shared failure texts of the record pages (`records.outcome.*`); `taken` and `state` codes
 * are translated by the page (`takenText`, `stateText`) because they name module rules.
 */
export function RecordNotice({
  notice,
  onReload,
  takenText,
  stateText,
}: {
  notice: RecordNoticeState | null;
  onReload: () => void;
  takenText?: (code: string) => string;
  stateText?: (code: string) => string;
}) {
  const t = useTranslations("records");
  const tCompany = useTranslations("company");
  if (!notice) return null;
  switch (notice.kind) {
    case "done":
      return <Alert tone="success">{notice.message}</Alert>;
    case "invalid":
      return <Alert tone="error">{t("outcome.invalid")}</Alert>;
    case "taken":
      return <Alert tone="error">{takenText?.(notice.code) ?? t("outcome.error")}</Alert>;
    case "state":
      return <Alert tone="error">{stateText?.(notice.code) ?? t("outcome.error")}</Alert>;
    case "conflict":
      return (
        <Alert tone="error">
          {t("outcome.conflict")}{" "}
          <button type="button" className="underline" onClick={onReload}>
            {t("reload")}
          </button>
        </Alert>
      );
    case "twoFactor":
      return (
        <Alert tone="error">
          {t("outcome.twoFactor")}{" "}
          <Link href="/account/two-factor">{tCompany("setUpTwoFactor")}</Link>
        </Alert>
      );
    default:
      return <Alert tone="error">{t(`outcome.${notice.kind}`)}</Alert>;
  }
}
