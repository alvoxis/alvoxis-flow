import "server-only";
import { createTranslator } from "next-intl";
import { CATALOGS } from "@/i18n/catalogs";
import { type AppLocale } from "@/i18n/config";
import { type EmailMessage } from "./mailer";

/** Plain-text, localized invitation to join a company. Values are inserted as plain text. */
export function invitationEmail(
  to: string,
  locale: AppLocale,
  values: { company: string; inviter: string; link: string; days: number },
): EmailMessage {
  const t = createTranslator({ locale, messages: CATALOGS[locale], namespace: "email" });
  return {
    kind: "invitation",
    to,
    subject: `ALVOXIS Flow: ${t("invitation.subject", { company: values.company })}`,
    text: `${t("greeting", { name: to })}\n\n${t("invitation.body", values)}\n\n—\n${t("footer")}\n`,
  };
}
